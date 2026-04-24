# Follow-up & AI Conversation Fix — Implementation Plan

Source task: [FOLOW_UP_AND_CONVERSATION_FIX.md](../FOLOW_UP_AND_CONVERSATION_FIX.md)
Target branch: `staging` → PR to `main`
Rollout unit: `SavedAccount.conversationStateV2Enabled` (per-account kill switch; `aiMaxReplies=5` ships unflagged as a safety fix)

This plan turns the 10-section task doc into three sequenced phases and pins the four architectural decisions up front so reviewers don't have to reverse-engineer them from the code.

---

## The four decisions

### Decision 1 — Conversation state lives on `ThreadContext`, not a new table

**Options considered**
- New `LeadConversationState` table with FK to `Conversation`.
- New columns on existing `ThreadContext`.

**Chosen: extend `ThreadContext`.** `ThreadContext` is already 1:1 with `Conversation`, already carries derived conversational state (`stage`, `customerIntent`, `engagementLevel`, `followUpStatus`, `lastCustomerMessageAt`, etc.), and every code path that matters (`automation.service`, `follow-up-engine.service`, `follow-up-scheduler.service`, `conversation-context.service`) already loads it. A separate table would double the write fanout on every inbound message (Message → ThreadContext → LeadConversationState) and create a second source of truth for "when did the customer last speak" — exactly the consistency problem Phase A is fixing.

**Risk accepted**: `ThreadContext` mixes source-of-truth and derived fields. We keep this under control by making new state columns write-only-through-`ConversationStateService` (Phase B). If the row grows wide enough to regret, extraction is a mechanical migration later.

### Decision 2 — Shared pre-send guard is a method on `ConversationStateService`, not a NestJS interceptor

**Options considered**
- NestJS interceptor over the two sending routes.
- A new top-level `GuardService`.
- A method on `ConversationStateService`: `canSendAutomatedMessage(conversationId, source)`.

**Chosen: method on `ConversationStateService`.** Interceptors don't fire where the actual sends happen — `automation.service.scheduleAutomatedMessage` and `follow-up-scheduler.service.processEnrollment` are service methods, not controller routes. A new `GuardService` would import both `FollowUpEngineService` and `ConversationStateService` and create a circular dependency. Keeping the guard next to the state it reads avoids both problems and makes the ownership obvious.

### Decision 3 — Nurture is a new module (`src/nurture-engine/`)

**Options considered**
- New `followUpMode='nurture'` value on `FollowUpEnrollment`.
- New cron method inside `FollowUpSchedulerService`.
- New module `src/nurture-engine/`.

**Chosen: new module.** Nurture cadence (30d / 90d / seasonal) is two orders of magnitude slower than follow-up, the stop rules differ (`found_someone` is a *trigger* for nurture, a *terminator* for follow-up), and piling it into the same scheduler loop would fight the existing file's readability. The new module reuses `FollowUpEnrollment` with `followUpMode='nurture'` so the partial unique index on `(conversationId) WHERE status='active'` still prevents nurture and follow-up from firing against the same conversation simultaneously. Uses a separate Postgres advisory lock ID (**7002**) and runs hourly (vs follow-up's 60s).

### Decision 4 — Yelp echo fallback fails **open** (treat unknown as customer reply, not echo)

**Options considered**
- Fail closed: on `getLeadEvents` failure, keep the current "pro message in last 90s = echo" heuristic.
- Fail open: on failure, treat the event as a customer reply AND queue reconciliation.

**Chosen: fail open + reconcile.** Failure modes are asymmetric. A false echo (miss a real customer reply) keeps follow-ups firing against an engaged customer — the user sees the bug, the customer gets spammed. A false customer reply (echo misclassified) stops one follow-up enrollment that would have fired anyway — invisible cost. The 90-second heuristic is deleted entirely. Uncertain events get marked `needs_reconciliation` on `WebhookEvent.processingError` and a new cron retries classification.

**Verification gate**: before Phase A merges, pull 30 days of `getLeadEvents` failure logs. If >80% of failures were actually echoes, revisit this decision. If the ratio is mixed or tilts toward customer replies, ship as planned.

---

## Four open questions (carried forward, not blockers for Phase A)

1. **User tier location** — Section 8 references Tier 2/3 differential alerts. No `User.tier` column was found; tier may be implicit in `trial.service.ts` or subscription records. Confirm before wiring differential alerting (Phase C).
2. **Nurture copy ownership** — Sections 5 & 6 have one-line examples. Product owner signoff on final tone/wording needed before coding nurture seed templates.
3. **Manual-send guard scope** — should `canSendAutomatedMessage` also gate human-operator sends? Read of the task says no (automation only). Deferring to Phase C; default is "manual sends bypass the guard."
4. **Seed template idempotency** — Sections 5 & 6 add new `FollowUpSequenceTemplate` rows via `follow-up-seed.ts` on boot. Current schema has no unique constraint on `(userId, platform, triggerState, isDefault)`; re-running the seed will duplicate. Add a unique constraint or move to Prisma `upsert` keyed on a stable natural key. Resolve before Phase C.

---

## Phase A — Persistence & signal integrity (this PR)

Addresses task sections 1 and 2. Everything downstream depends on "can the system reliably detect a customer reply?" Phase A makes the answer yes, for Yelp specifically (Thumbtack already persists inbound messages).

### Scope

1. Migration: add `Lead.lastCustomerActivityAt DateTime?` + index.
2. New method `ConversationContextService.ensureMessagePersisted(input)` — upsert to `Message` by `(platform, externalMessageId)`, bump `Lead.lastCustomerActivityAt` when `sender='customer'`, delegate to existing `recordMessage` for `ThreadContext` updates.
3. Yelp webhook change at `src/webhooks/webhooks.service.ts`:
   - Reorder so the latest Yelp event is fetched **once** up front and reused for both echo classification and `ensureMessagePersisted`.
   - Delete the 90-second fallback. Replace with: on fetch failure, mark the `WebhookEvent` with `processingError='reconcile:yelp:<leadId>'` and treat the event as a customer reply.
   - Add structured logs: `[yelp_event_fetch_failed]`, `[yelp_event_reconciliation_scheduled]`, `[customer_reply_detected]`, `[echo_confirmed]`.
4. Second cron in `FollowUpSchedulerService.reconcileYelpEvents()` — `@Cron(EVERY_5_MINUTES)`, reuses advisory lock pattern (new lock id **7003**), capped at 5 retries per event.
5. Widen scheduler self-heal at `follow-up-scheduler.service.ts:381` — stop enrollment when *either* `Message.sender='customer' AND sentAt > enrollment.createdAt` *or* `Lead.lastCustomerActivityAt > enrollment.createdAt`.

### Acceptance (Phase A ships when all pass)

- Yelp customer reply creates a `Message` row synchronously with the webhook POST.
- Dedup safe: same event processed twice results in exactly one `Message` row (enforced by `@@unique([platform, externalMessageId])`).
- 90-second fallback path is gone from the code (grep returns zero hits).
- `getLeadEvents` failure path marks `WebhookEvent.processingError` with `reconcile:` prefix and treats event as customer reply.
- `reconcileYelpEvents` cron reclassifies at least one test event successfully.
- Scheduler self-heal stops an enrollment when `lastCustomerActivityAt > enrollment.createdAt` even if `Message` has no customer row yet (cross-provider safety net).
- Existing Yelp test suite (`src/integrations/yelp-integrations.controller.spec.ts` if present; otherwise the webhook tests) still green.
- New tests (Section 10 cases 1, 2, 8) written and green.

### Phase A does NOT include

- New state-machine columns (Phase B).
- Intent classifier extraction (Phase B).
- Shared pre-send guard (Phase C).
- Nurture engine (Phase C).
- `aiMaxReplies` default change (Phase C — the one safety fix that ships without the V2 flag).

---

## Phase B — State machine foundation (next PR)

Addresses task section 3. Builds `ConversationStateService`, intent classifier, and the state column set on `ThreadContext`. Not implemented here; documented in the original plan and gated behind `SavedAccount.conversationStateV2Enabled=false` on rollout.

## Phase C — Behavior changes (subsequent PRs)

Addresses task sections 4–9. Stop-on-reply wiring, resume-after-silence, Nurture Engine, AI end conditions (including `aiMaxReplies` default → 5), manager alerts, shared pre-send guard.

## Phase D — Tests, rollout, cleanup

Addresses task section 10. Per-account flag ramp: one internal account → friendly betas → global.

---

## Risks (from original plan, re-stated for persistence)

1. **Yelp echo fail direction** (Decision 4) — verify failure-mode ratio before merge.
2. **Intent classifier precision** (Phase B) — false `found_someone` parks a live lead for 30 days. Hand-audit 200 archived customer messages before flipping the V2 flag.
3. **`ThreadContext` write contention** (Phase B) — 8 new columns on the hottest write in the system. Measure before/after in staging smoke test.

---

## File map (Phase A)

| Change | File |
|---|---|
| Migration | `prisma/migrations/<ts>_add_lead_last_customer_activity/migration.sql` |
| Schema | `prisma/schema.prisma` (Lead model) |
| New method | `src/conversation-context/conversation-context.service.ts` |
| Yelp webhook rewrite | `src/webhooks/webhooks.service.ts` (echo block ~1715–1754 + persistence around 1685) |
| Reconcile cron | `src/follow-up-engine/follow-up-scheduler.service.ts` |
| Scheduler self-heal widen | `src/follow-up-engine/follow-up-scheduler.service.ts` (processEnrollment ~381) |
| Tests | `src/webhooks/webhooks.service.spec.ts` (new), `src/follow-up-engine/follow-up-scheduler.service.spec.ts` (extend) |
