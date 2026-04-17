
---

## AI Agent Task — Fix Follow-up Duplicate Enrollment / Rapid Send Bug Properly

### Goal

Fix the follow-up bug where the same conversation can receive multiple follow-up messages within minutes because duplicate active enrollments are being created and the send gap is enforced per-enrollment instead of per-conversation.

This task should **not** be implemented as a narrow patch only. We need a fix that is safe under concurrency, easy to reason about, and prevents the same class of bug from returning.

---

## Problem Summary

There are likely **two core issues**:

### 1) Duplicate active follow-up enrollments can be created for the same conversation

Current enrollment flow appears to do a read-then-write check like:

* find active enrollment for conversation
* if none exists, create one

This is being called from multiple paths, so parallel requests can race and create 2–3 active enrollments for the same conversation.

Result:

* one conversation ends up with multiple active enrollments
* scheduler processes each one
* customer gets several follow-up messages in a very short time

### 2) Send cooldown is enforced per enrollment instead of per conversation

Current gap logic seems tied to `lastExecutedAt` or equivalent on a single enrollment.

That is the wrong safety boundary.

Business rule is:

> a conversation must not receive follow-up messages too close together, regardless of how many enrollment rows exist

So cooldown/throttle must be enforced at the **conversation-level follow-up state**, not per enrollment record.

---

## Required Fix Direction

## 1. Make “one active follow-up state per conversation” a hard invariant

We need to enforce in code and database that a conversation can only have **one active follow-up enrollment/state** at a time.

### Requirements

* Add a DB-level constraint or equivalent mechanism to prevent multiple active enrollments for the same conversation
* Refactor enrollment creation into **one idempotent service method**
* All entry points must go through that single method
* If concurrent calls happen, system should safely return the already-existing active enrollment instead of creating a duplicate

### Notes

Using a unique constraint plus handling duplicate-insert error is acceptable.
But do not rely on controller/webhook-side checks alone.

The invariant must hold even under concurrent requests.

---

## 2. Move follow-up send cooldown to the conversation level

Do **not** keep the effective send gap logic scoped only to one enrollment row.

### Required behavior

Before sending any follow-up, system must check the most recent follow-up send time for the **conversation as a whole**.

That means one of these approaches:

* store `lastFollowUpSentAt` on conversation-level follow-up state
* or store equivalent on the conversation/thread itself
* or another single-source-of-truth field with the same effect

### Important

Do **not** solve this by repeatedly scanning across all historical enrollments unless absolutely necessary for backward compatibility.
Prefer a clean conversation-level source of truth.

---

## 3. Make scheduler execution safe under overlap / concurrency

Even if duplicate enrollment creation is fixed, scheduler still must not double-send if:

* cron overlaps
* two workers are running
* same due item is picked twice

### Requirements

Implement atomic claiming / locking / lease behavior for due follow-up work.

Examples of acceptable patterns:

* update row from `pending` to `processing` atomically and only continue if claim succeeds
* use a processing lease timestamp
* use DB row locking if appropriate for the stack

### Goal

One due follow-up step should only be processed once, even under concurrent scheduler execution.

---

## 4. Clean up existing bad data

We likely already have conversations with multiple active enrollments.

### Required cleanup

Create a one-time repair script or migration-safe maintenance script that:

* finds conversations with more than one active enrollment
* keeps only one valid active enrollment
* deactivates/stops the others
* preserves history where needed
* does not break already-completed or archived records

Prefer keeping:

* the oldest valid active enrollment, or
* whichever choice matches current business logic best

Document the chosen rule.

---

## 5. Quiet hours investigation is separate

Do not mix quiet-hours config debugging with the main duplicate enrollment fix.

However, after the core fix, verify whether follow-ups and AI auto-replies use separate quiet-hours settings and whether the reported nighttime sends were:

* true follow-ups
* or AI/instant replies under a different quiet-hours system

If needed, note any mismatch, but keep that as a separate follow-up item.

---

## Implementation Expectations

### Refactor requirements

* Centralize follow-up enrollment logic into one service path
* Remove or minimize scattered enrollment decisions from controllers/webhooks/services
* Make the enrollment method idempotent
* Ensure database-enforced safety, not just in-memory safety

### Data model requirements

We want a model where the system behaves as if there is exactly one active follow-up state per conversation.

If current schema uses enrollments, that is fine, but runtime logic should still be based on a single active state per conversation.

### Backward compatibility

Handle existing conversations gracefully.
Do not break already completed/stopped follow-up histories.

---

## Deliverables

### 1) Code changes

* DB/schema changes for active-enrollment uniqueness
* service refactor for idempotent enrollment creation
* scheduler refactor for conversation-level cooldown
* scheduler concurrency protection / atomic claim
* cleanup script for duplicate active enrollments

### 2) Short technical note

Provide a concise summary covering:

* root cause
* what invariant is now enforced
* where cooldown now lives
* how duplicate sends are prevented under concurrent scheduler execution

### 3) Tests

Add or update tests for the following cases:

#### Enrollment concurrency

* two parallel enrollment calls for same conversation
* result: only one active enrollment exists

#### Multiple entry points

* webhook + manual trigger + lead flow hitting same conversation
* result: still only one active enrollment

#### Cooldown safety

* duplicate historical enrollments exist
* send logic still blocks based on conversation-level last sent time

#### Scheduler concurrency

* two scheduler workers/processes attempt same due follow-up
* only one send occurs

#### Cleanup script

* conversation with 3 active enrollments
* after cleanup, only one remains active

#### Regression

* normal single enrollment flow still works
* completed/stopped enrollments remain intact

---

## Acceptance Criteria

This task is complete only if all of the following are true:

* A conversation cannot end up with multiple active follow-up enrollments under concurrent requests
* A conversation cannot receive multiple follow-up sends within the cooldown window due to duplicate enrollments
* Scheduler cannot double-send the same due follow-up under overlapping execution
* Existing duplicate active enrollments can be safely repaired
* Logic is centralized enough that future enrollment race bugs are unlikely
* Quiet-hours concerns remain logically separated from this fix

---

## Preferred Outcome

We want a **proper system fix**, not just a patch.

That means:

* DB-enforced invariant
* idempotent enrollment creation
* conversation-level cooldown
* scheduler-side atomic claim
* one-time repair of corrupted active state

Do not stop at “add a unique check and query all enrollments for last sent time” unless a cleaner conversation-level state is impossible in current architecture.

---

# Implementation Plan

## 0. Evidence from current code

All line refs verified against current `staging` branch.

### 0a. Race condition on enrollment
[src/follow-up-engine/follow-up-engine.service.ts:110-117](src/follow-up-engine/follow-up-engine.service.ts#L110-L117) — read-then-write, no DB constraint, no transaction:

```ts
const existing = await this.prisma.followUpEnrollment.findFirst({
  where: { conversationId, status: 'active' },
});
if (existing) return existing.id;
// ... then prisma.followUpEnrollment.create(...)
```

Callers (≥6 concurrent paths):
- [src/webhooks/webhooks.service.ts:743](src/webhooks/webhooks.service.ts#L743) — Thumbtack `evaluateThread`
- [src/webhooks/webhooks.service.ts:1842](src/webhooks/webhooks.service.ts#L1842) — Yelp `evaluateThread`
- [src/leads/leads.service.ts:648](src/leads/leads.service.ts#L648) — `enrollInSequence` after `sendMessage`
- [src/follow-up-engine/follow-up-engine.controller.ts:344](src/follow-up-engine/follow-up-engine.controller.ts#L344), [:401](src/follow-up-engine/follow-up-engine.controller.ts#L401), [:672](src/follow-up-engine/follow-up-engine.controller.ts#L672), [:812](src/follow-up-engine/follow-up-engine.controller.ts#L812)

### 0b. Per-enrollment gap instead of per-conversation
[src/follow-up-engine/follow-up-scheduler.service.ts:198-210](src/follow-up-engine/follow-up-scheduler.service.ts#L198-L210) gates on `enrollment.lastExecutedAt`. Each duplicate has its own `lastExecutedAt=null` → all fire in the same cycle.

### 0c. Scheduler loop processes all duplicates
[src/follow-up-engine/follow-up-scheduler.service.ts:152-180](src/follow-up-engine/follow-up-scheduler.service.ts#L152-L180) fetches up to 20 due enrollments and iterates sequentially without grouping by `conversationId`. Explains the Jeffrey pattern (step 0 / 1 / 2 in consecutive minutes) and Lia pattern (3 steps in the same minute).

### 0d. Quiet hours (out of scope here — note only)
[src/follow-up-engine/follow-up-scheduler.service.ts:231-272](src/follow-up-engine/follow-up-scheduler.service.ts#L231-L272) reads `fuQuietHoursEnabled/Start/End` from `savedAccount.followUpSettingsJson`. Default 22:00-08:00 wouldn't block 08:42 PM / 09:56 PM. Handle as a separate follow-up (§5).

---

## 1. DB invariant: one active enrollment per conversation

Prisma does NOT support partial unique indexes natively — ship as raw SQL.

### 1a. Migration directory
`prisma/migrations/20260417120000_followup_unique_active_per_conversation/migration.sql`:

```sql
-- prisma-migrate-disable-transaction
-- (CREATE INDEX CONCURRENTLY cannot run inside a transaction)

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  "follow_up_enrollments_conversation_active_unique"
ON "follow_up_enrollments" ("conversation_id")
WHERE "status" = 'active';
```

### 1b. Schema comment
Add a pointer in `prisma/schema.prisma` next to the existing `FollowUpEnrollment` indexes so future editors don't overlook the raw SQL invariant:

```prisma
// NOTE: Partial unique index enforced via raw SQL migration
//   20260417120000_followup_unique_active_per_conversation:
//     CREATE UNIQUE INDEX ... ON follow_up_enrollments (conversation_id) WHERE status = 'active';
```

### 1c. Prerequisite
Cleanup script in §4 MUST run before the index is created — otherwise `CREATE UNIQUE INDEX CONCURRENTLY` fails and leaves the index `INVALID`.

---

## 2. Idempotent `enrollInSequence` (transaction + P2002)

Replace the enroll block in `src/follow-up-engine/follow-up-engine.service.ts` with a transactional create that catches `Prisma.PrismaClientKnownRequestError` code `P2002` and returns the winner:

```ts
import { Prisma } from '@prisma/client';

try {
  const enrollment = await this.prisma.$transaction(async (tx) => {
    const existing = await tx.followUpEnrollment.findFirst({
      where: { conversationId, status: 'active' },
      select: { id: true },
    });
    if (existing) return existing;

    const created = await tx.followUpEnrollment.create({
      data: {
        sequenceTemplateId: templateId,
        conversationId,
        leadId,
        platform,
        status: 'active',
        currentStepIndex: startStepIndex,
        nextStepDueAt: effectiveNextDue,
        mode: enrollMode,
      },
      select: { id: true },
    });

    await tx.threadContext.updateMany({
      where: { conversationId },
      data: {
        activeEnrollmentId: created.id,
        nextFollowUpAt: effectiveNextDue,
        followUpStatus: 'active',
      },
    });

    return created;
  });

  return enrollment.id;
} catch (err) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const winner = await this.prisma.followUpEnrollment.findFirst({
      where: { conversationId, status: 'active' },
      select: { id: true },
    });
    if (winner) {
      this.logger.warn(`[FollowUp] P2002 race on conversation ${conversationId} — returning existing ${winner.id}`);
      return winner.id;
    }
  }
  throw err;
}
```

No call-site changes — all paths route through `enrollInSequence` and inherit the guard.

`onModuleInit` re-activation at [scheduler:95-127](src/follow-up-engine/follow-up-scheduler.service.ts#L95-L127) must also guard against an existing active sibling before flipping `stopped → active` (the partial index will otherwise block the update).

---

## 3. Conversation-level cooldown (single source of truth)

### 3a. Data model — add `lastFollowUpSentAt` to ThreadContext
Extend `ThreadContext` with a `lastFollowUpSentAt DateTime?` field. This becomes the authoritative conversation-level timestamp (alongside the existing `nextFollowUpAt`, `activeEnrollmentId`, `followUpStatus` cache fields).

Prisma migration (standard — no `CONCURRENTLY` needed):

```prisma
model ThreadContext {
  // ... existing fields
  lastFollowUpSentAt DateTime?
}
```

### 3b. Write path
In `follow-up-scheduler.service.ts`, after a successful auto-send (around [:427](src/follow-up-engine/follow-up-scheduler.service.ts#L427)) AND after a successful manual approve-suggestion in the controller, set:

```ts
await this.prisma.threadContext.updateMany({
  where: { conversationId: enrollment.conversationId },
  data: { lastFollowUpSentAt: now },
});
```

Back-populate existing rows in the same migration:

```sql
UPDATE thread_contexts tc
SET "lastFollowUpSentAt" = sub.last_sent
FROM (
  SELECT fue.conversation_id, MAX(fse."executedAt") AS last_sent
  FROM follow_up_step_executions fse
  JOIN follow_up_enrollments fue ON fue.id = fse."enrollmentId"
  WHERE fse.status = 'sent'
  GROUP BY fue.conversation_id
) sub
WHERE tc.conversation_id = sub.conversation_id;
```

### 3c. Read path — replace per-enrollment gap check
In `follow-up-scheduler.service.ts:198-210`, replace with:

```ts
const tc = await this.prisma.threadContext.findFirst({
  where: { conversationId: enrollment.conversationId },
  select: { lastFollowUpSentAt: true },
});

if (tc?.lastFollowUpSentAt) {
  const sinceLastSend = Date.now() - tc.lastFollowUpSentAt.getTime();
  if (sinceLastSend < 10 * 60_000) {
    const nextDue = new Date(tc.lastFollowUpSentAt.getTime() + 10 * 60_000);
    await this.prisma.followUpEnrollment.update({
      where: { id: enrollment.id },
      data: { nextStepDueAt: nextDue },
    });
    this.logger.log(`[FollowUpScheduler] Conversation-level cooldown — rescheduled ${enrollment.id} to ${nextDue.toISOString()}`);
    return;
  }
}
```

Keep `lastExecutedAt` being written on the enrollment row (debug / UI), but it is no longer the gate.

---

## 4. Atomic scheduler claim

### 4a. Row-level claim via conditional update
Today [scheduler:151-161](src/follow-up-engine/follow-up-scheduler.service.ts#L151-L161) does `findMany` → iterate. Two overlapping cron ticks (or a second pod) can return the same row.

Replace with an atomic claim using Prisma's `updateMany` with a `version`-like guard. Add `processingUntil DateTime?` + `processingToken String?` to `FollowUpEnrollment`.

Claim pattern per enrollment:

```ts
const token = randomUUID();
const leaseEnd = new Date(Date.now() + 2 * 60_000);

const { count } = await this.prisma.followUpEnrollment.updateMany({
  where: {
    id: enrollment.id,
    status: 'active',
    nextStepDueAt: { lte: now },
    OR: [{ processingUntil: null }, { processingUntil: { lt: now } }],
  },
  data: { processingUntil: leaseEnd, processingToken: token },
});
if (count === 0) {
  // another worker claimed it
  return;
}
```

On successful processing, clear the lease in the same write that advances the step. On error, leave the lease — it will auto-expire after 2 minutes.

### 4b. Keep advisory lock as outer guard
The existing `pg_try_advisory_lock(7001)` at [scheduler:144-149](src/follow-up-engine/follow-up-scheduler.service.ts#L144-L149) remains. The per-row claim is defense-in-depth for the case where two pods ever hold the lock briefly during deploys.

### 4c. Per-conversation dedup inside the cycle
Before the loop, group `dueEnrollments` by `conversationId`, pick the oldest `createdAt`, stop the rest with `stoppedReason: 'duplicate_cleanup'`:

```ts
const byConversation = new Map<string, typeof dueEnrollments>();
for (const e of dueEnrollments) {
  const arr = byConversation.get(e.conversationId) ?? [];
  arr.push(e);
  byConversation.set(e.conversationId, arr);
}

for (const [, group] of byConversation) {
  group.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const [canonical, ...duplicates] = group;

  if (duplicates.length > 0) {
    await this.prisma.followUpEnrollment.updateMany({
      where: { id: { in: duplicates.map(d => d.id) } },
      data: { status: 'stopped', stoppedReason: 'duplicate_cleanup', completedAt: new Date() },
    });
    await this.prisma.followUpStepExecution.updateMany({
      where: { enrollmentId: { in: duplicates.map(d => d.id) }, status: { in: ['scheduled', 'suggested'] } },
      data: { status: 'cancelled' },
    });
  }

  await this.processEnrollment(canonical, now);
}
```

---

## 5. One-time data repair

Run BEFORE the §1a migration. Keeps oldest active enrollment per conversation.

```sql
BEGIN;

-- Preview — record this count
WITH ranked AS (
  SELECT id, conversation_id,
         ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at ASC, id ASC) AS rn
  FROM follow_up_enrollments
  WHERE status = 'active'
)
SELECT conversation_id, COUNT(*) AS dup_count
FROM ranked WHERE rn > 1
GROUP BY conversation_id ORDER BY dup_count DESC;

-- Stop duplicates (keep oldest)
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at ASC, id ASC) AS rn
  FROM follow_up_enrollments WHERE status = 'active'
)
UPDATE follow_up_enrollments
SET status = 'stopped',
    "stoppedReason" = 'duplicate_cleanup',
    "completedAt" = NOW(),
    "updatedAt" = NOW()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Cancel pending suggestions/scheduled on stopped duplicates
UPDATE follow_up_step_executions
SET status = 'cancelled'
WHERE "enrollmentId" IN (
  SELECT id FROM follow_up_enrollments
  WHERE status = 'stopped'
    AND "stoppedReason" = 'duplicate_cleanup'
    AND "completedAt" > NOW() - INTERVAL '5 minutes'
) AND status IN ('scheduled', 'suggested');

-- Sanity: must return 0
SELECT conversation_id, COUNT(*)
FROM follow_up_enrollments WHERE status = 'active'
GROUP BY conversation_id HAVING COUNT(*) > 1;

COMMIT;  -- only after 0-row sanity check
```

Also deliver a Node script `scripts/cleanup-duplicate-enrollments.ts` wrapping the same logic (idempotent, logs ids it touches).

Verify column casing (`stoppedReason`, `completedAt`, `enrollmentId`) against the live DB — Prisma quotes camelCase by default but `@map` directives may change that.

---

## 6. Quiet-hours investigation (separate follow-up)

Diagnostic queries — run AFTER the duplicate fix ships, but keep the quiet-hours fix in its own PR.

```sql
SELECT sa.id, sa."followUpTimezone",
  (sa."followUpSettingsJson"::jsonb) ->> 'fuQuietHoursEnabled' AS quiet_enabled,
  (sa."followUpSettingsJson"::jsonb) ->> 'fuQuietHoursStart'    AS quiet_start,
  (sa."followUpSettingsJson"::jsonb) ->> 'fuQuietHoursEnd'      AS quiet_end
FROM saved_accounts sa
WHERE sa.id IN (SELECT sa2.id FROM saved_accounts sa2
                JOIN leads l ON l."userId" = sa2."userId" AND l."businessId" = sa2."businessId"
                WHERE l."customerName" IN ('Jeffrey', 'Lia') OR l."customerName" ILIKE 'Jeffrey%' OR l."customerName" ILIKE 'Lia%');
```

Hypotheses to confirm:
- `quiet_enabled = 'false'` or `NULL` → UI save path bug
- partial fields → UI save path bug
- enabled + correct window + `followUpTimezone` null → scheduler default `America/New_York` mismatch
- Lia 05:15 AM initial = auto-reply (AI Conversation), which uses separate `ccQuiet*` fields in `NotificationSettings` — verify it was the right feature that sent

Treat missing fields as "user wants quiet, apply safe defaults (21:00–09:00 in account timezone)" instead of silently ignoring.

---

## 7. Tests

### 7a. `src/follow-up-engine/follow-up-engine.service.spec.ts`
1. **Concurrent enroll — one winner**: two parallel `enrollInSequence` calls on the same conversation; force `P2002` on the loser's create. Assert both return the same id and the DB has exactly one `active` row.
2. **Multi-entry-point concurrency**: mock webhook + manual + lead-flow calls firing in parallel; assert one active row.
3. **Non-P2002 error re-thrown**.

### 7b. `src/follow-up-engine/follow-up-scheduler.service.spec.ts`
1. **Conversation-level cooldown**: seed `ThreadContext.lastFollowUpSentAt = now - 5min`, run `processEnrollment`; assert reschedule + no `generateMessage` call.
2. **Cooldown holds even with duplicate enrollments**: seed 2 active enrollments + one recent send; assert neither sends.
3. **Grouping defense**: seed 3 active enrollments on one conversation (bypassing the DB index via raw `$executeRaw`); run `processFollowUps`; assert 2 stopped with `duplicate_cleanup`, 1 processed, 1 new execution row.
4. **Atomic claim**: two concurrent `processEnrollment` calls on the same row; assert only one advances the step.
5. **Canonical by `createdAt`**: out-of-order array, oldest wins.

### 7c. Cleanup script tests
1. Conversation with 3 active → after script, 1 active + 2 stopped with `duplicate_cleanup`.
2. Completed / stopped rows untouched.
3. Associated pending executions cancelled.

### 7d. Regression
- Single-enrollment happy path unchanged.
- Completed enrollments' history preserved.

---

## 8. Rollout

Scheduler runs production-only (`FOLLOWUP_SCHEDULER=false` on staging, see [scheduler:37-39](src/follow-up-engine/follow-up-scheduler.service.ts#L37-L39)). Staging exercises the enroll path + unit tests but not the scheduler end-to-end.

### Phase 1 — Staging
1. Merge to `staging`.
2. CI green (new spec suites pass).
3. Smoke test: hit `POST /follow-up/enroll` twice in parallel via `curl` on the same conversation — assert same id returned, one DB row.

### Phase 2 — Production cleanup (before index)
1. `psql` to prod; run §5 preview. Record count.
2. Run §5 `BEGIN … COMMIT` block. Verify sanity check returns 0 rows.

### Phase 3 — Production migration
1. Apply §1a index via `psql` directly (Prisma can't run `CONCURRENTLY`).
2. `npx prisma migrate resolve --applied 20260417120000_followup_unique_active_per_conversation`.
3. Verify `\d follow_up_enrollments` shows the partial unique index.

### Phase 4 — Code deploy to production
1. Merge `staging` → `main`. Railway deploys `thumbtack-bridge-production`.
2. Tail Grafana/Railway for:
   - `[FollowUp] P2002 race …` — expected ≤ a few per day.
   - `[FollowUpScheduler] Found N duplicate active enrollments …` — expected 0 after cleanup.
   - Exception handler entries.
3. Monitor 24h; spot-check 20 recently enrolled conversations → each has ≤1 active.

### Phase 5 — Quiet hours (separate PR)
Ship fix based on §6 findings.

---

## 9. Risks + rollback

### Risks
- Cleanup collapses legitimately distinct enrollments (different templates). Mitigation: log stopped ids + templateIds; `/follow-up/enrollments/:id/resume` to revive.
- Partial unique index blocks stopped→active re-activation in `onModuleInit`. Mitigation: pre-check for sibling active before updating.
- `CREATE UNIQUE INDEX CONCURRENTLY` leaves an `INVALID` index if duplicates remain. Mitigation: `DROP INDEX`, rerun cleanup, retry.
- New `ThreadContext.lastFollowUpSentAt` read path on every process — add `@@index([conversationId])` on ThreadContext if missing (likely present already).
- Lease-based atomic claim needs wall-clock tolerance — use 2min lease, auto-expire on failure.

### Rollback
- **Code**: revert the merge commit. Index stays; it only enforces the intended invariant.
- **Index**: `DROP INDEX CONCURRENTLY follow_up_enrollments_conversation_active_unique;` only if it starts blocking legitimate writes (indicates code still wants multiple active rows — investigate first).
- **Cleanup data**: per-row revive via `UPDATE follow_up_enrollments SET status='active', "stoppedReason"=NULL, "completedAt"=NULL WHERE id='<id>';` — only works if no sibling active exists (else the partial index blocks).

---

## 10. Critical files

- [src/follow-up-engine/follow-up-engine.service.ts](src/follow-up-engine/follow-up-engine.service.ts)
- [src/follow-up-engine/follow-up-scheduler.service.ts](src/follow-up-engine/follow-up-scheduler.service.ts)
- [src/follow-up-engine/follow-up-engine.controller.ts](src/follow-up-engine/follow-up-engine.controller.ts)
- [src/webhooks/webhooks.service.ts](src/webhooks/webhooks.service.ts)
- [src/leads/leads.service.ts](src/leads/leads.service.ts)
- [prisma/schema.prisma](prisma/schema.prisma)
- `prisma/migrations/20260417120000_followup_unique_active_per_conversation/migration.sql` (new)
- `scripts/cleanup-duplicate-enrollments.ts` (new)
- [src/follow-up-engine/follow-up-engine.service.spec.ts](src/follow-up-engine/follow-up-engine.service.spec.ts)
- [src/follow-up-engine/follow-up-scheduler.service.spec.ts](src/follow-up-engine/follow-up-scheduler.service.spec.ts)

