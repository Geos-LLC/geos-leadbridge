# Bi-Directional Job Status Sync — Service Flow ↔ LeadBridge

**Status:** Draft for review. Planning only — no code, no migrations.
**Builds on:** `JOB_SYNC_SF_LB.md` task spec, and the already-shipped LB → SF outbound path (`src/crm-webhooks/crm-webhook.service.ts`).

---

## 1. Recommended architecture

### 1.1 Event flow overview

```
                             [Yelp / Thumbtack dashboards]
                                   ^                 |
                                   |                 v
                            (scrape)             (scrape)
                                   |                 |
                            [Chrome extension]───────┘
                                   |
                                   v  POST /v1/integrations/{yelp|thumbtack}/leads/collect
                                   |  (discrepancy audit only, post-rollout)
                                   v
   ┌──────────────────────────────────────────────────────────────┐
   │                         LeadBridge (LB)                      │
   │                                                              │
   │  POST /v1/integrations/service-flow/job-status  ◄──── webhook│◄──┐
   │                      │                                       │   │
   │                      v                                       │   │
   │          SfInboundStatusService                              │   │
   │           (lookup → validate → write)                        │   │
   │                      │                                       │   │
   │                      v                                       │   │
   │                    Lead.status / statusSource / …            │   │
   │                      │                                       │   │
   │                      v                                       │   │
   │     follow-up-engine.service.ts (terminal skip) ◄───reads────│   │
   │     follow-up-scheduler.service.ts                           │   │
   │                                                              │   │
   │  CrmWebhookService.emit('lead.status_changed')  ─────────────│──┐│
   │                                                              │  ││
   └──────────────────────────────────────────────────────────────┘  ││
                                                                     ││
   ┌──────────────────────────────────────────────────────────────┐  ││
   │                       Service Flow (SF)                      │  ││
   │                                                              │  ││
   │  PATCH /api/jobs/:id/status (server.js:6068)  ───────────────│──┘│ (new emit)
   │  PUT   /api/team-members/jobs/:jobId/status                  │   │
   │  internal job creation (server.js:5975 initial insert)       │   │
   │                      │                                       │   │
   │                      v                                       │   │
   │        jobs table + job_status_history                       │   │
   │                      │                                       │   │
   │                      v                                       │   │
   │        SfOutboundStatusEmitter (new)                         │   │
   │         - resolves SF job → LB lead mapping                  │   │
   │         - calls LB webhook endpoint                          │───┘
   │                                                              │
   │  POST /api/integrations/leadbridge/webhooks (existing)       │◄── LB outbound
   │    leadbridge-service.js:665 — receives LB events            │
   └──────────────────────────────────────────────────────────────┘
```

### 1.2 Ownership boundaries

| Domain | Owner | Rationale |
|---|---|---|
| Internal job/pipeline status (`pending`, `confirmed`, `in-progress`, `completed`, `cancelled`, `rescheduled`) | **Service Flow** | SF is where day-to-day job management happens (`server.js:6068`) |
| Platform-native states (Thumbtack `Hired`/`Not hired`/`Archived`; Yelp `archived`) | **Yelp/Thumbtack** (authoritative), captured via extension | SF has no connection to platform-native UI state |
| Early-funnel states (`new`, `contacted`, `quoted`) for a lead before it becomes an SF job | **LeadBridge** | These happen in LB's messaging layer, before a job record exists in SF |
| Customer identity, conversation state, message history | **LeadBridge** | Unchanged |
| Follow-up automation reaction to status | **LeadBridge** (consumes) | LB already branches on terminal status |

### 1.3 Webhook-first, extension-fallback

- Primary channel: SF emits `job.status_changed` to LB in near real time (< 5 s p95).
- Extension / platform sync role is downgraded to **discrepancy audit** (see §6).
- No polling from LB to SF. No polling from SF to LB for status.

---

## 2. Source-of-truth rules

### 2.1 Status domains

Split status into two conceptual axes on every LB `Lead`:

1. **Pipeline status** (`Lead.status`) — the operational status used by follow-ups and UI.
2. **Platform-native status** (`Lead.thumbtackStatus` today; future `Lead.platformStatus` for Yelp). Never overwritten by SF.

### 2.2 Authority table

| Field on LB Lead | Written by | Notes |
|---|---|---|
| `Lead.status` | SF (primary), LB manual UI, LB automation | SF wins if SF event is newer than last write. Never written by platform sync. |
| `Lead.thumbtackStatus` / `platformStatus` | Platform sync (extension) only | Never overwritten by SF. Read-only for SF. |
| `Lead.statusSource` (new) | Always set by whoever wrote last | `service_flow` \| `platform_sync` \| `manual` \| `lb_automation` |
| `Lead.statusUpdatedAt` (new) | Whoever wrote last | Used for out-of-order rejection. |
| `Lead.sfJobId` (new) | SF → LB on first status event | Sticky; never cleared. |
| `Lead.sfLastEventAt` (new) | SF inbound handler | Last accepted SF event timestamp. |

### 2.3 Discrepancy resolution rules

When SF pipeline says X and platform says Y:

| SF status | Platform status | Resolution |
|---|---|---|
| `completed` / `paid` | `Hired` | Consistent — no action |
| `completed` | `Not hired` / `Archived` | Flag for review, do not overwrite. Create `LeadStatusAuditLog` entry with `conflict=true`. |
| `in-progress` / `confirmed` | `Archived` on platform | Flag. SF is authoritative for job progress, but log the anomaly — operator may want to re-archive in SF or dispute with platform. |
| `pending` (no SF action yet) | `Hired` | Flag. Means SF never picked up the conversion; push alert to operator. |
| Any | `Not hired` | **Do NOT stop follow-ups automatically.** Trigger `FollowUpEngine.evaluateThread()` to re-decide based on engagement (§7.2). Engaged leads switch to long-term mode; ghost leads stop. |
| `cancelled` | `Hired` | Flag — customer may have re-booked elsewhere. |

Rule of thumb: **LB never silently overwrites the disagreeing side, and platform status is a *signal*, not a command.** Discrepancy audit produces entries in `LeadStatusAuditLog` with `conflict=true`; operator UI surfaces them. Platform status only updates `Lead.platformStatus` and triggers re-evaluation of follow-up mode; it never changes `Lead.status` and never by itself stops an active enrollment.

### 2.4 Status authority clarification

- **Service Flow** controls pipeline status (`Lead.status`). Only SF, manual UI edits, and LB automation can write it.
- **Platform status** (`Lead.thumbtackStatus` / future `Lead.platformStatus`) does **not** override pipeline status. It is advisory.
- Platform status role:
  1. Provide external signal (did the customer click "Not hired" on Thumbtack?)
  2. Influence follow-up strategy (short-term → long-term switch)
  3. Surface discrepancies for operator attention
- Platform status role NOT:
  1. Stop automation by itself
  2. Rewrite `Lead.status`
  3. Count as a terminal state for the follow-up engine

---

## 3. Status mapping model

### 3.1 Mapping identifier

**Decision: use a hybrid — prefer explicit `sfJobId` mapping, fall back to `(platform, externalRequestId)`.**

- When SF creates a job from an LB-originated lead (via `resolveOrCreateLead` in `leadbridge-service.js:213`), SF should persist the LB `externalRequestId` (Thumbtack negotiation ID / Yelp lead ID) on its job record in a new column `jobs.lb_external_request_id` and `jobs.lb_channel`.
- SF's outbound webhook sends BOTH `sf_job_id` AND `external_request_id` + `channel`.
- LB lookup order:
  1. Lookup by `Lead.sfJobId = payload.sf_job_id` (fast path once mapping is seeded).
  2. Fallback: `Lead.platform = payload.channel AND Lead.externalRequestId = payload.external_request_id`. On hit, backfill `Lead.sfJobId` and `Lead.sfJobMappedAt`.
  3. Miss: log to `SfInboundDeadLetter` with reason `lead_not_found` (see §9).

**Why not just a `SfLeadMapping` table?** The 1:1 relationship between SF job and LB lead is stable. Storing the mapping directly on `Lead` avoids a join on every inbound. A mapping table adds value only if the same LB lead can correspond to multiple SF jobs — an open question (§11).

### 3.2 Status normalization

Create a canonical enum `LB_PIPELINE_STATUS` used as `Lead.status`:

```
new | contacted | quoted | scheduled | in_progress | completed | cancelled | no_show | lost | archived
```

SF → LB canonical mapping table (maintained in a single shared helper in LB, e.g. `src/crm-webhooks/sf-status-map.ts`):

| SF status (`server.js:6075-6083`) | LB canonical |
|---|---|
| `pending` | `scheduled` (if a schedule exists on the SF job) / else `contacted` |
| `confirmed` | `scheduled` |
| `in-progress` / `in_progress` | `in_progress` |
| `completed` | `completed` |
| `cancelled` | `cancelled` |
| `rescheduled` | `scheduled` |
| (team-member endpoint `en-route`, `started`) | `in_progress` |
| (SF unknown) | **reject with 422** — never silently coerce |

Platform-native passthrough (never touched by SF handler): Thumbtack `Hired`, `Not hired`, `Scheduled`, `Archived` all remain in `Lead.thumbtackStatus`.

### 3.3 Legacy records

LB leads that exist today with no `sfJobId`:
- Backfill script (one-off, run after SF has emitted at least once for each known job) matches on `(platform, externalRequestId)`.
- Leads with no matching SF job stay unlinked; they only receive SF updates when/if a future event references them.
- No destructive migration. The fallback lookup (§3.1 step 2) handles legacy on the fly.

---

## 4. Webhook contract

### 4.1 Endpoint

`POST /v1/integrations/service-flow/job-status`

- Mounted in a new NestJS controller `src/integrations/service-flow/service-flow-inbound.controller.ts`.
- Public endpoint — no JWT. Authentication is HMAC signature + subscription lookup.
- Body limit: 64 KB. Content-Type: `application/json`.

### 4.2 Request payload

```json
{
  "event_id": "evt_01HXYZ...",
  "event_type": "job.status_changed",
  "occurred_at": "2026-04-17T14:23:05.123Z",
  "source": "service_flow",
  "source_instance": "sf-prod",

  "sf_job_id": "9c3e...",
  "sf_user_id": "42",

  "external_request_id": "tt_neg_abc",
  "channel": "thumbtack",
  "sf_lead_id": "sf_lead_123",

  "status": {
    "new": "in_progress",
    "previous": "confirmed",
    "canonical": "in_progress"
  },

  "actor": {
    "type": "account_owner",
    "id": "42",
    "display_name": "Jane Doe"
  },

  "job": {
    "scheduled_date": "2026-04-20T16:00:00Z",
    "customer_name": "Angela Candela",
    "amount": null
  },

  "raw": { }
}
```

Field rules:
- `event_id` is REQUIRED. LB uses it for idempotency.
- `occurred_at` is REQUIRED. LB uses it for out-of-order detection.
- `sf_job_id` is REQUIRED. `external_request_id` + `channel` is strongly recommended for first-time mapping.
- `status.new` REQUIRED. `status.canonical` optional.

### 4.3 Authentication

- Header: `X-SF-Signature: sha256=<hex>` (new; mirrors LB's existing `X-LB-Signature` format at `src/crm-webhooks/crm-webhook.service.ts:241`).
- Header: `X-SF-Timestamp: <unix_seconds>` — reject if drift > 300 s.
- Header: `X-SF-Subscription-Id: <uuid>` — tells LB which secret to use.
- Signature = `HMAC_SHA256(secret, timestamp + '.' + rawBody)` (same scheme as outbound; symmetric for engineering ergonomics).

### 4.4 Subscription storage

Reuse the existing `CrmWebhookSubscription` model (`prisma/schema.prisma:1255`) with direction extended:

- Add `direction: 'outbound' | 'inbound'` (default `outbound` for backward compat). Inbound rows store the **secret SF uses to sign**.
- Unique constraint becomes `(userId, direction, webhookUrl)` OR for inbound rows `webhookUrl` may be null and uniqueness is `(userId, direction, name)`.
- On LB user's SF connect flow, SF calls a new endpoint `POST /v1/integrations/service-flow/subscribe` that creates the inbound subscription and returns the shared secret for SF to store.

### 4.5 Response codes

| Code | Meaning | Retry? |
|---|---|---|
| `200 { "status": "accepted", "event_id": "...", "result": "applied"\|"noop"\|"deferred" }` | Processed or deliberately ignored | No |
| `202` | Accepted, processing async (if we move to queue) | No |
| `400` | Malformed payload / missing required field | No |
| `401` | Signature invalid | No |
| `404` | Subscription not found | No |
| `409` | Event already processed (idempotency hit) — returns same body as first success | No |
| `422` | Known-shape payload, but unknown SF status value; logged for mapping work | No |
| `429` | Rate limit | Yes with backoff |
| `5xx` | LB bug or downstream failure | Yes with exponential backoff |

### 4.6 Retry expectations (SF side)

- 5 attempts total: immediate, +10 s, +1 min, +10 min, +1 h.
- Dead-letter after final failure into a new SF table `leadbridge_outbound_dlq`.
- Only retry on `5xx`, `429`, and network errors.

---

## 5. LeadBridge inbound processing flow

Service: `src/integrations/service-flow/sf-inbound-status.service.ts` (new).

### 5.1 Pipeline

```
1.  Verify HMAC (X-SF-Signature + X-SF-Timestamp + subscription secret)
      └─► fail: 401, no further processing

2.  Parse + validate payload schema (class-validator DTO)
      └─► fail: 400

3.  Idempotency check:
      SELECT * FROM SfInboundEvent WHERE event_id = payload.event_id
      if found → return 409 with stored result

4.  Lookup LB lead:
      a) by Lead.sfJobId = payload.sf_job_id
      b) else by (platform=payload.channel, externalRequestId=payload.external_request_id)
      c) else: persist SfInboundEvent with status='deferred', result='lead_not_found'
         return 200 { result: 'deferred' }

5.  Loop-prevention guard:
      if payload.source == 'service_flow' AND lead.statusSource == 'service_flow'
         AND occurred_at <= lead.sfLastEventAt
         → no-op, store event as 'stale', return 200 { result: 'noop' }

6.  Map SF status → canonical LB status (§3.2).
      Unknown? → return 422, store event with result='unmapped_status'.

7.  Compute update decision:
      - canonical == lead.status AND sf_job_id matches → no-op
      - occurred_at < lead.statusUpdatedAt AND lead.statusSource != 'service_flow'
          → no-op (manual/automation wrote something newer); log audit entry
      - otherwise → write

8.  Transactional write:
      UPDATE Lead SET
        status           = canonical,
        sfJobId          = COALESCE(lead.sfJobId, payload.sf_job_id),
        statusSource     = 'service_flow',
        statusUpdatedAt  = payload.occurred_at,
        sfLastEventAt    = payload.occurred_at,
        updatedAt        = now()
      WHERE id = lead.id
         AND (statusUpdatedAt IS NULL OR statusUpdatedAt < payload.occurred_at OR statusSource = 'service_flow')

      INSERT INTO LeadStatusAuditLog (
        leadId, oldStatus, newStatus, source='service_flow',
        sourceEventId=payload.event_id, actorType, actorId, occurredAt, payloadJson
      )

      INSERT INTO SfInboundEvent (event_id, leadId, status='applied', ...)

9.  React to status:
      - If canonical is terminal → stop active FollowUpEnrollment(s) for the lead's thread
        (call FollowUpEngineService.stopEnrollment with reason='sf_status_<canonical>')
      - If canonical reopens a terminal → emit internal 'lead.reopened' event (see §7)
      - Emit SSE to UI for live refresh (reuse existing SSE bus — to confirm with frontend team)

10. Return 200 { status: 'accepted', result: 'applied' }
```

### 5.2 Loop prevention — the important rule

- LB's existing outbound `lead.status_changed` emit at `src/leads/controller.ts:159` runs when `Lead.status` changes via the LB REST API.
- Inbound SF handler writes with `statusSource='service_flow'`.
- **Hard rule:** the outbound emitter MUST suppress events where the write originated from SF. Two options; pick one (§11 open question):
  - (A) Gate the emit on `statusSource !== 'service_flow'` at the emitter.
  - (B) Pass an `originContext` through the write path so the handler knows to skip emit.
- Recommended: (A) at the LB emitter, because it's robust across all write paths (API, automation, inbound webhook).

### 5.3 UI live refresh

- Today LB pushes SSE events for inbox updates (confirm path). Inbound SF status change should publish `thread.status_changed` onto the same bus so dashboards update without refresh.
- If SSE is not universally wired, fall back to optimistic UI refresh on next poll — not a blocker.

---

## 6. Platform discrepancy sync design

### 6.1 New role for the Chrome extension post-webhook

Post-rollout, platform sync transitions from **primary refresh** to **discrepancy audit + platform-native capture**.

Responsibilities:
1. Capture platform-native status (`thumbtackStatus`, future `yelpStatus`) — still the only way to get these values.
2. Detect disagreement between platform-native and SF pipeline (§2.3).
3. Capture historical/initial state for leads that predate webhook coverage.

It no longer updates `Lead.status` directly. It only writes `Lead.thumbtackStatus` / `platformStatus`.

### 6.2 Cron frequency

- Extension is user-triggered today. Keep it that way as manual + once-per-day scheduled refresh when the extension is open.
- No server-side cron polling Yelp/Thumbtack. LB does not have direct API access for this.
- Server-side cron (`@Cron('0 */4 * * *')` — every 4 hours): **discrepancy auditor**. Scans recent leads where `lead.status` disagrees with `lead.thumbtackStatus` per the §2.3 table; writes `LeadStatusAuditLog` entries with `conflict=true` when found.

### 6.3 What the audit checks

For each `Lead` where `updatedAt > now() - 7 days`:
- If `lead.thumbtackStatus == 'Not hired'` AND `lead.status NOT IN ('cancelled', 'lost', 'archived')` → **trigger `FollowUpEngine.evaluateThread()`** with platform-signal context. The engine decides based on engagement (§7.2) whether to stop (ghost lead) or switch to long-term mode (engaged lead). Create audit entry; notify operator only if the lead is engaged and switching modes.
- If `lead.thumbtackStatus == 'Hired'` AND `lead.status IN ('new', 'contacted', 'quoted')` → SF never registered the booking. Create audit entry, do NOT change `lead.status` (SF is supposed to own it).
- If `lead.thumbtackStatus == 'Archived'` AND `lead.status IN ('in_progress', 'scheduled')` → flag only.

### 6.4 Overwrite vs flag policy

- **Never overwrites `Lead.status` from platform data.** Period.
- **Never stops follow-ups solely because of a platform status.** Platform status only triggers re-evaluation; the engine decides the rest.
- Always writes an entry to `LeadStatusAuditLog` for non-trivial platform signals.
- Operator UI (future, §11) surfaces conflicts for manual reconciliation.

### 6.5 Re-evaluation trigger

When the extension (or discrepancy cron) writes a new value to `Lead.thumbtackStatus` / `Lead.platformStatus`:

```
if newPlatformStatus IN ('Not hired', 'Archived', 'Hired') AND newPlatformStatus != oldPlatformStatus:
    FollowUpEngine.evaluateThread(lead.threadId, { platformSignal: newPlatformStatus })
```

This fires synchronously from the update path, not from a cron — so the system adapts within seconds of the platform signal, not hours.

### 6.5 Repair flow

- No automated repair back into SF in phase 1. LB does not push platform-native state into SF today; creating that channel is a separate decision (§11).
- If the operator manually resolves the conflict in SF, the next SF → LB webhook naturally harmonizes the data.

---

## 7. Follow-up / automation behavior

Current terminal list at `src/follow-up-engine/follow-up-engine.service.ts:40` and `src/follow-up-engine/follow-up-scheduler.service.ts:303`.

### 7.1 Reaction to canonical LB status post-SF event

SF pipeline status is authoritative and has hard rules:

| Canonical | Reaction |
|---|---|
| `new`, `contacted`, `quoted` | **Continue** — eligible for follow-up |
| `scheduled` | **Stop enrollment** with reason `sf_status_scheduled`. Terminal. |
| `in_progress` | **Stop** with reason `sf_status_in_progress`. Terminal. |
| `completed` | **Stop** with reason `sf_status_completed`. Terminal. |
| `cancelled` | **Stop** with reason `sf_status_cancelled`. Terminal. Keep the lead record. |
| `no_show` | **Switch to long-term mode** (§7.4). Customer didn't show, but may reschedule. |
| `lost` | **Stop** — terminal. |
| `archived` | **Stop** — terminal. |

### 7.2 Reaction to platform signals (engagement-aware)

Platform signals (especially `Not hired` / `Archived`) do **not** stop follow-ups automatically. Instead, the engine evaluates engagement and picks a follow-up strategy:

```
on platformSignal = 'Not hired' for lead:
  engaged = isEngaged(lead)
  explicitStop = hasExplicitOptOut(lead.threadId)

  if explicitStop:
    stopEnrollment(reason='customer_opted_out')         // highest priority
  elif lead.status in TERMINAL_SF_STATUSES:
    stopEnrollment(reason='sf_status_<lead.status>')    // SF already terminal
  elif not engaged:
    stopEnrollment(reason='platform_not_hired_ghost')   // ghost lead, cut losses
  else:
    switchToLongTermMode(reason='platform_not_hired_engaged')
```

Decision priority (highest first):
1. Explicit customer opt-out ("stop", "don't contact", etc. — detected by existing opt-out scanner) → **always stop**
2. SF pipeline status is terminal (`scheduled`, `in_progress`, `completed`, `cancelled`, `lost`, `archived`) → **stop**
3. Platform signal `Not hired` + **no engagement** (ghost) → **stop**
4. Platform signal `Not hired` + **engaged** → **switch to long-term mode**
5. Anything else → **continue current mode**

### 7.3 "Engaged" definition

A lead is `engaged` if **any** of these are true (checked against `ThreadContext` + `Message` records):

- Customer has replied at least once after the initial request (`customerMessages > 0` when excluding the initial lead form)
- Price was discussed in the thread (`ThreadContext.priceDiscussed = true`)
- A booking attempt was made (`ThreadContext.stage ∈ {booking, scheduling}` or equivalent)
- Thread has ≥ 4 total messages (initial + at least 3 back-and-forth)
- `ThreadContext.engagementLevel ∈ {warm, hot}` as set by the conversation classifier

A lead is `ghost` if none of the above are true (customer never replied, no price/booking discussion, short thread).

Helper: `FollowUpEngineService.isEngaged(threadId): boolean` — consolidates the check in one place so the rule is consistent across entry points.

### 7.4 Long-term follow-up mode

New concept on `FollowUpEnrollment`:

```
followUpMode: 'short_term' | 'long_term'   (default: short_term)
```

**Short-term mode** (existing behavior): current seeded sequences (minutes → hours → days, up to ~2 weeks).

**Long-term mode** (new): sparser, friendlier cadence targeting re-engagement, not conversion:

| Step | Delay from last contact | Tone |
|---|---|---|
| 1 | +7 days | "Checking in — are you still looking at cleaning options?" |
| 2 | +14 days (21 since last) | "We have availability this week if you want to revisit." |
| 3 | +30 days (51 since last) | "Just a reminder — need cleaning again?" |
| 4 | +90 days (141 since last) | Seasonal / recurring cleaning reminder |

Long-term templates are new preset entries (similar shape to existing seeded presets at `src/follow-up-engine/follow-up-seed.ts`). Messages reference the lead's original service without being pushy.

**Mode switching:**
- `FollowUpEngineService.switchToLongTermMode(enrollmentId, reason)` — updates `enrollment.followUpMode = 'long_term'`, resets `currentStepIndex = 0`, sets `nextStepDueAt = now + 7 days`, records audit entry.
- `switchToShortTermMode(enrollmentId, reason)` — reverse transition when a ghosted-then-replying customer returns. Also resets index.
- The scheduler reads `followUpMode` to pick which step sequence to use.

**Template selection:**
- The step loader (`follow-up-scheduler.service.ts:getUserConfiguredSteps`) branches on `followUpMode`. User-configured steps are still short-term; long-term uses the seeded long-term preset for the matching trigger state.
- User can override long-term steps per account in Services settings (future enhancement, not phase 1).

### 7.5 Re-engagement after long-term silence

If a lead in `long_term` mode has a customer reply:
- Existing `handleCustomerReply` already stops the enrollment (customer_replied).
- On next `evaluateThread`, if the lead is now engaged and SF status is still non-terminal, the engine enrolls again in **short-term** mode (back to the active pipeline).
- This is the "ghost → returns → warm" path (Case E below).

### 7.6 Stop vs pause vs unenroll

- **Stop (unenroll)** is the existing primitive (`FollowUpEngineService.stopEnrollment`). Use it for all stop decisions above.
- **Long-term mode** is the "pause-ish" state — enrollment remains `active`, but sends are weeks apart. No new `paused` status required.
- Explicit customer opt-out always uses `stopEnrollment(reason='customer_opted_out')`.

### 7.7 Re-open semantics (SF status transitions)

If SF goes `completed → in_progress` (job reopened):
- Terminal → terminal. No change.

If SF goes `cancelled → confirmed` (rebooked):
- `cancelled → scheduled`. Still terminal. Don't re-enroll. Optional operator alert.

If SF goes `scheduled → pending` (canonical `contacted`):
- Re-evaluate via `evaluateThread`. If engaged, enroll in short-term. If ghost, no enrollment.

If SF goes from any terminal → non-terminal:
- Trigger `evaluateThread` with `reason='sf_status_reopened'`.

### 7.8 Idempotency

`FollowUpEngineService.stopEnrollment` and `switchToLongTermMode` must be idempotent — duplicate SF events or repeated platform signals must not create double audit rows or re-reset long-term timers.

### 7.9 Edge cases checklist

| Case | Scenario | Behavior |
|---|---|---|
| **A** | No reply, platform `Not hired` | **Stop** (ghost) |
| **B** | Replied, then silence, platform `Not hired` | **Long-term mode** |
| **C** | Customer said "don't contact" / "stop" | **Stop immediately** (opt-out — highest priority, overrides everything) |
| **D** | SF status is `completed` / `scheduled` / `cancelled` / etc. | **Stop** (SF terminal always wins over platform signals) |
| **E** | Lead in long-term mode replies months later | `handleCustomerReply` stops enrollment; `evaluateThread` enrolls in short-term |
| **F** | Platform `Not hired`, then customer replies | `handleCustomerReply` stops long-term enrollment; re-enrolls in short-term on next `evaluateThread` |
| **G** | Platform `Not hired` flips back to `Hired` / `Active` | Trigger `evaluateThread`. If still in long-term mode and now actively hired, operator alert; SF should fire separately. No auto-downgrade. |

---

## 8. Schema + API changes

### 8.1 LB `Lead` additions (`prisma/schema.prisma`, ~line 175)

```
sfJobId          String?   // SF jobs.id — sticky mapping
sfJobMappedAt    DateTime?
sfLastEventAt    DateTime? // last accepted SF event occurred_at
statusSource     String?   // 'service_flow'|'platform_sync'|'manual'|'lb_automation'
statusUpdatedAt  DateTime? // when Lead.status last changed; used for ordering
platformStatus   String?   // generic platform-native status (replaces thumbtackStatus long-term)
platformStatusAt DateTime? // when platform status was last observed
```
Indexes: `@@index([sfJobId])`, `@@index([statusSource])`.

### 8.1b `FollowUpEnrollment` additions

```
followUpMode  String   @default("short_term")  // 'short_term' | 'long_term'
modeChangedAt DateTime?
modeReason    String?  // 'platform_not_hired_engaged' | 'ghost_returned' | etc.
```
Index: `@@index([followUpMode, status])` for scheduler queries.

### 8.2 New table: `SfInboundEvent` (idempotency + dead-letter)

```
id             String   @id @default(uuid())
eventId        String   @unique      // payload.event_id
userId         String?                // resolved LB user
leadId         String?                // resolved LB lead (null if deferred)
sfJobId        String?
sfSubscriptionId String?
eventType      String
occurredAt     DateTime
receivedAt     DateTime @default(now())
status         String   // 'applied'|'noop'|'deferred'|'stale'|'unmapped_status'|'unauthorized'
result         String?
payloadJson    Json
@@index([leadId])
@@index([status, receivedAt])
@@index([sfJobId])
```

### 8.3 New table: `LeadStatusAuditLog`

```
id           String   @id @default(uuid())
leadId       String
oldStatus    String?
newStatus    String
source       String   // 'service_flow'|'platform_sync'|'manual'|'lb_automation'
sourceEventId String? // e.g. SfInboundEvent.eventId when source=service_flow
actorType    String?  // 'account_owner'|'team_member'|'system'|'operator'
actorId      String?
actorName    String?
conflict     Boolean  @default(false)   // true for discrepancy-audit rows
conflictNote String?
occurredAt   DateTime
createdAt    DateTime @default(now())
@@index([leadId, occurredAt])
@@index([conflict])
```

### 8.4 `CrmWebhookSubscription` additions (`prisma/schema.prisma:1255`)

```
direction     String   @default("outbound")  // 'outbound'|'inbound'
lastEventAt   DateTime?                       // for inbound: last received
```
Unique constraint update: `@@unique([userId, direction, webhookUrl])` (outbound semantics preserved; inbound rows use a synthetic `webhookUrl` like `sf://<instance>/<sub-id>` or store null with `@@unique([userId, direction, name])`).

### 8.5 SF-side schema additions (flagged for SF team, not LB's responsibility)

- `jobs.lb_external_request_id` (text, nullable), `jobs.lb_channel` (text, nullable). Populated at SF job creation time when the job originates from an LB-sourced lead (see `resolveOrCreateLead` in `leadbridge-service.js:213`).
- `leadbridge_outbound_subscriptions` (id, user_id, lb_webhook_url, secret, is_active, created_at). Or reuse whatever SF already has for outbound.
- `leadbridge_outbound_dlq` (event_id, payload, attempts, last_error, last_attempt_at).

### 8.6 New LB endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/integrations/service-flow/job-status` | **Inbound SF status webhook** (primary new endpoint) |
| `POST` | `/v1/integrations/service-flow/subscribe` | SF registers itself as inbound source; returns shared secret |
| `GET` | `/v1/integrations/service-flow/events` | (admin) list recent `SfInboundEvent` rows for debugging |
| `POST` | `/v1/integrations/service-flow/events/:id/replay` | (admin) re-apply a stuck event |
| `GET` | `/v1/leads/:id/status-audit` | read `LeadStatusAuditLog` for a lead — powers UI timeline |

### 8.7 SF-side changes (coordination list)

- Emit on every write to `jobs.status`:
  - `server.js:6068` (`PATCH /api/jobs/:id/status`) — primary.
  - `server.js:5975` (initial job creation status insert) — send `job.status_changed` with `previous=null`.
  - `server.js:23052` (`PUT /api/team-members/jobs/:jobId/status`) — team-member path.
  - Any other place `jobs.status` is mutated (`server.js:13072`, `server.js:11649`) — grep for `.update(` on table `jobs` and instrument.
- Emitter module: `service-flow-backend/leadbridge-outbound.js` (new). Wraps the LB webhook call, signs, retries, DLQ.
- `leadbridge-service.js` connect flow extends to call LB's `/v1/integrations/service-flow/subscribe` during `POST /api/integrations/leadbridge/connect`.

---

## 9. Risks / edge cases

| # | Risk | Mitigation |
|---|---|---|
| 1 | Out-of-order events (net retry puts older status after newer) | Conditional UPDATE `WHERE statusUpdatedAt < payload.occurred_at`. Log the ignored event in `SfInboundEvent` with `status='stale'`. |
| 2 | Duplicate events (SF retries after 200 lost) | `event_id` unique index on `SfInboundEvent`. Duplicate → 409 with original result. |
| 3 | Lead not found in LB (SF refers to a job whose LB lead never existed) | `SfInboundEvent.status='deferred'` with `result='lead_not_found'`. Return 200 (not 404) to avoid SF retry storm. Admin replay endpoint can re-run once lead appears. |
| 4 | Unknown SF status (e.g. new value `on_hold` we haven't mapped) | 422. Store event. Operator adds mapping; hit replay endpoint. Critical to not silently drop. |
| 5 | Signature verification failure | 401. Store event with `status='unauthorized'`. Do not process. Alert if rate exceeds threshold — may indicate secret drift. |
| 6 | Loop: SF → LB → SF → LB | Three defenses: (a) outbound emitter suppresses when `Lead.statusSource='service_flow'` (§5.2); (b) SF-side de-dup on `jobs.status` unchanged writes; (c) `source` field on inbound payloads — if we ever receive `source='service_flow'` on our outbound we halt. |
| 7 | Two SF jobs map to one LB lead (customer re-contacts through same platform thread) | Open question §11. Default: `Lead.sfJobId` holds the most recent; audit log captures the history. Could be resolved with `SfLeadMapping` if it happens often. |
| 8 | Concurrent writes (SF webhook + LB manual UI edit arrive simultaneously) | Optimistic concurrency via the conditional UPDATE on `statusUpdatedAt`. Loser's event gets `result='noop'`, audit log captures the near-miss. |
| 9 | SF DB transaction commits, webhook dispatch fails permanently | SF DLQ. Reconciliation cron (SF side) nightly resends DLQ items and reports unrecoverable ones. |
| 10 | LB extension continues writing `Lead.status` post-rollout | Bug — extension must be updated to only write `Lead.thumbtackStatus`. Add a guard in `IntegrationsService.collectLeadIds` (`src/integrations/integrations.service.ts:89`) behind feature flag `SF_STATUS_WINS` that ignores status field from extension for leads where `sfJobId IS NOT NULL`. |
| 11 | Platform-native terminal (`Not hired`) arrives AFTER SF `completed` | No conflict; both terminal. Leave alone. |
| 12 | SF emits `status_changed` to a deactivated LB user | Subscription has `isActive=false` → 404 on subscribe-time lookup at LB, or 200-noop if subscription row missing. SF logs, no retry. |
| 13 | Webhook body too large or malformed | 400 with specific error code. SF does not retry. |
| 14 | LB cold start drops events while module loads | SF DLQ handles — 5xx triggers retry backoff. |
| 15 | `occurred_at` clock skew between SF and LB | Mitigated by using SF's clock as authoritative for ordering; 300 s skew tolerance on HMAC timestamp is independent from `occurred_at`. |

---

## 10. Rollout plan

### 10.1 Feature flags

LB side (env vars, read in `ConfigService`):
- `SF_INBOUND_WEBHOOK_ENABLED` (default `false`) — master kill switch for the new endpoint. When off, returns 503.
- `SF_INBOUND_WEBHOOK_DRY_RUN` (default `true` initially) — receive + validate + log, but do NOT write to `Lead`. Used to verify payload shape and lookup hit rate in production before switching to write mode.
- `SF_STATUS_WINS` (default `false`) — when true, activate the extension guard (risk #10) and authority rules in §2.
- `LB_OUTBOUND_STATUS_SUPPRESS_SF_ORIGIN` (default `true`) — loop guard. Never turn off in production.

SF side:
- `LEADBRIDGE_OUTBOUND_STATUS_ENABLED` (default `false`) — master switch for emitting.
- `LEADBRIDGE_OUTBOUND_DRY_RUN` — log the payload but don't POST.

### 10.2 Phased order

**Phase 0 — coordination (week 0)**
- Align with SF team on SF-side schema additions (§8.5).
- Confirm the SF connect flow registers LB subscriptions.

**Phase 1 — LB endpoint in dry-run (week 1)**
- Ship `POST /v1/integrations/service-flow/job-status` behind `SF_INBOUND_WEBHOOK_ENABLED=true`, `DRY_RUN=true`.
- Ship `SfInboundEvent`, `LeadStatusAuditLog` tables. New `Lead` columns.
- Outbound loop guard (`LB_OUTBOUND_STATUS_SUPPRESS_SF_ORIGIN`) enabled.
- No writes yet. Purely observational.

**Phase 2 — SF emits in dry-run (week 2)**
- SF instruments `PATCH /api/jobs/:id/status` to build and log payloads. No POSTs yet.
- Verify payload format matches contract on SF logs.

**Phase 3 — Live delivery, LB still dry-run (week 3)**
- SF POSTs to LB. LB receives, validates, stores in `SfInboundEvent`, but does not update `Lead`.
- Monitor: lookup hit rate, unmapped_status rate, signature failures.

**Phase 4 — LB writes enabled for pilot users (week 4)**
- Flip `SF_INBOUND_WEBHOOK_DRY_RUN=false` for 2–3 pilot LB users.
- Watch `LeadStatusAuditLog` for anomalies; compare with extension-derived state.

**Phase 5 — Full rollout (week 5)**
- Flip `DRY_RUN=false` globally.
- Enable `SF_STATUS_WINS=true` — extension stops writing `Lead.status`.
- Keep extension for platform-native status only.

**Phase 6 — Deprecate manual sync paths (week 6+)**
- Audit every caller of `IntegrationsService.collectLeadIds` that sets `Lead.status` directly. Remove those writes, keep `thumbtackStatus` writes.
- Document new contract in operator-facing docs.

**Phase 7 — Long-term follow-up mode (parallel to 4–6)**
- Seed long-term preset templates (7d / 14d / 30d / 90d) for each `triggerState`.
- Ship `followUpMode` column + `switchToLongTermMode` / `switchToShortTermMode` helpers.
- Add `isEngaged(threadId)` helper consolidating the engagement check.
- Wire the platform-signal re-evaluation path in `evaluateThread` to honor the decision tree in §7.2.
- Enable behind feature flag `ENGAGEMENT_AWARE_FOLLOWUPS` (default `false`); flip to `true` once templates are reviewed and the engagement check is spot-checked against 20 real threads.

### 10.3 Observability

- **Metrics** (Prometheus-style, however LB emits today):
  - `sf_inbound_events_total{result="applied|noop|deferred|stale|unmapped_status|unauthorized"}`
  - `sf_inbound_events_latency_seconds` (receive → commit)
  - `sf_inbound_lookup_hit_total{method="sf_job_id|external_request_id|none"}`
  - `sf_inbound_dryrun_would_apply_total` during dry-run
  - `lb_followup_stopped_by_sf_total{reason="sf_status_<x>"}`
  - `sf_inbound_conflict_total` (out-of-order or authority override)
- **Logs**: structured, include `event_id`, `sf_job_id`, `lead_id`, `result`. Reuse NestJS `Logger`.
- **Alerts**:
  - Signature failure rate > 5/min for any subscription.
  - Unmapped-status rate > 0 (anything unmapped is a product-level alert).
  - Deferred event backlog > 100.
  - Hourly summary to ops channel.

### 10.4 Rollback

Each phase is independent:
- Phase 1–3: flip `SF_INBOUND_WEBHOOK_ENABLED=false`. LB returns 503, SF DLQs, no data loss.
- Phase 4–5: flip `DRY_RUN=true`. Writes stop. Audit log retains history. `SfInboundEvent` is source of truth to replay later.
- Phase 6: revert extension flag. Extension resumes writing `Lead.status`. Lossless.

Schema is additive only; no destructive migration means any phase can roll back without a down migration.

---

## 11. Open questions / decisions to confirm

0. **Engagement threshold.** Current proposal: ≥1 customer reply, OR price discussed, OR booking attempt, OR ≥4 messages, OR `engagementLevel ∈ {warm, hot}`. Is 4 messages the right cutoff, or should it be 3? Is `warm` enough or should only `hot` count?
0a. **Long-term cadence.** 7d / 14d / 30d / 90d — confirm spacing. Should we stop at 90d or keep going seasonally (180d, 365d)?
0b. **Long-term message content.** Templates shown are placeholders. Needs copy review before phase 7 flip.
0c. **Platform-signal re-evaluation scope.** Do we re-evaluate only on `Not hired` / `Archived` / `Hired`, or on every platform status change? Current proposal: only the three that represent meaningful state transitions.
1. **`SfLeadMapping` table vs direct `Lead.sfJobId` column.** Plan assumes 1:1 is sufficient. Confirm: can one LB lead correspond to multiple SF jobs over time (e.g. customer rebooks months later)? If yes, table is needed.
2. **Do we stop LB's outbound `lead.status_changed` to SF entirely post-rollout?** Current proposal: keep it, but suppress when `statusSource='service_flow'`. Alternative: stop emitting the event type to SF altogether once SF is authoritative. The suppression route is safer for non-SF CRM consumers, but "stop emitting" is simpler for a single-consumer world.
3. **Should `scheduled` stop follow-ups immediately or allow a final "reminder" touch?** Current plan: stop. Operator feedback wanted.
4. **SSE / live UI refresh path.** Does LB frontend already consume an SSE stream for thread updates? If yes, what event name — can we reuse it? If not, drop this from phase 1.
5. **Platform-native → SF corrective push.** When platform says `Not hired` but SF says `in-progress`, should we *tell* SF, or only flag? Flag-only is the default; confirm this matches business expectations.
6. **Authority when actor is `account_owner` vs `team_member`.** Currently treated identically — both are authoritative SF writes. Confirm no need for actor-based gating.
7. **Subscription secret rotation.** How does SF rotate the inbound secret? Need `PATCH /subscriptions/:id/rotate-secret` endpoint on LB. Scope decision: phase 1 or later.
8. **Backfill strategy for `sfJobId`.** One-off job at rollout, or lazy (populate on first SF event)? Lazy is simpler and matches the fallback lookup; confirm acceptable.
9. **Status domain for Yelp specifically.** Plan covers Thumbtack via `thumbtackStatus`. Yelp has no dedicated column today (`lead.status` is used, per prompt). When SF starts sending for Yelp-sourced leads, does the extension need a new `yelpStatus` column so we preserve the split authority model? Recommended: yes, add `Lead.platformStatus` + `Lead.platformStatusSource` generic, deprecate `thumbtackStatus`.
10. **Retention of `SfInboundEvent.payloadJson`.** 30 days? 90 days? Affects audit and storage. Suggest 90 days with compression.
11. **DLQ location.** `SfInboundEvent` with non-terminal `status` doubles as LB-side DLQ. Do we want a separate table for ops clarity, or a view?
12. **Rate limits on `/v1/integrations/service-flow/job-status`.** Suggest 100 req/s per subscription. Confirm expected SF throughput.

---

### Critical files for implementation

- `prisma/schema.prisma` (add `Lead` columns, `SfInboundEvent`, `LeadStatusAuditLog`; extend `CrmWebhookSubscription`)
- `src/crm-webhooks/crm-webhook.service.ts` (loop-prevention guard in `emit`; reuse of `sendWebhook` for inbound subscription test flow)
- `src/follow-up-engine/follow-up-engine.service.ts` (line 40 terminal list alignment; call surface for `stopEnrollment` from inbound handler)
- `src/follow-up-engine/follow-up-scheduler.service.ts` (line 303 terminal list alignment)
- `service-flow/service-flow-backend/server.js` (instrument `PATCH /api/jobs/:id/status` at line 6068 and sibling status-mutation sites at 5975, 23052, 13072)
- `service-flow/service-flow-backend/leadbridge-service.js` (extend `connect` flow to register inbound subscription; add new `leadbridge-outbound.js` sibling for the emitter)
