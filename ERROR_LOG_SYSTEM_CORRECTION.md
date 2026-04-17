
The biggest problems:

1. **Wrong email system**
   You asked for **SendGrid**, but the plan still uses **EmailJS**. That should be corrected now, not later.

2. **It treats health as error logs**
   Using `SystemErrorLog` as the main source of truth for health is fragile. Error logs are for history/debugging. Health status should have its **own snapshot/state**.

3. **It will still spam you**
   “One digest per hour” still means you can get the same unresolved issue every hour forever. That is better than 162 logs, but still not good enough.

4. **Detection logic is too indirect**
   “Token dead = unresolved token_refresh errors” is not a clean health check. That is inference from failures, not a direct status model.

5. **UI still depends on derived logic**
   The dashboard should reflect a **server-computed account health state**, not recompute from partial client fields.

## What I would approve instead

### Core principle

Build a **separate health monitoring layer** with three concerns:

* **Detection**: scheduled checks determine current account/system status
* **State**: store the latest health snapshot per account
* **Notification**: send alert emails only on state change or reminder windows

That keeps monitoring independent from error logging.

---

# Refactored plan

## 1. Keep error dedup, but do not use error logs as health source

This part is good and should stay:

* deduplicate repeated unresolved errors by `(category, accountId, fingerprint)`
* route proactive token refresh failures through `MonitoringService.captureError(...)`

But add a better dedup key than only `(category, accountId)`.
Use something like:

* `category`
* `accountId`
* `code`
* optional `provider`

Otherwise unrelated issues for the same account can collapse incorrectly.

Example:

* `token_expired`
* `webhook_missing`
* `automation_failure`

## 2. Add explicit health state storage

Create a table like `AccountHealthStatus` or `SystemHealthStatus`.

Suggested fields:

* `id`
* `userId`
* `accountId`
* `platform`
* `status` (`healthy`, `warning`, `critical`)
* `issueCode` (`token_expired`, `webhook_missing`, `notifications_disabled`, `automation_failures`)
* `issueMessage`
* `firstDetectedAt`
* `lastDetectedAt`
* `lastCheckedAt`
* `resolvedAt`
* `isActive`
* `lastNotifiedAt`
* `notificationCount`
* `metadata` JSON

This becomes the source of truth for:

* dashboard status
* layout warnings
* digest email generation
* future audit trail

## 3. Hourly cron should write health snapshots, not just inspect logs

The cron is the right idea, but it should do this:

### Schedule

Run hourly, for example:

* token refresh cron at `:00`
* health check cron at `:10`

Good.

### Per account checks

For each saved account:

* **Token health**

  * Prefer direct validation from current auth state or last refresh result
  * If provider-specific validation exists, use it
  * If not, infer from structured token status fields, not raw logs alone

* **Webhook health**

  * Missing webhook ID
  * Optionally stale webhook validation result
  * Optionally last webhook receipt age if applicable

* **Notifications health**

  * No enabled notification routes when expected

* **Automation health**

  * repeated automation failures in last 24h
  * threshold-based, not single incidental error

* **Connectivity freshness**

  * optional: last successful sync / last inbound event / last outbound success
  * very useful in real life

### Output

Upsert health rows per issue.
If issue no longer exists, resolve the row.

That gives you stable open/close health incidents.

## 4. Email alerts should be event-based, not “send every hour”

This is the most important refactor.

Instead of:

* every hour send a digest of all active issues

Do:

* send an email when a **new issue opens**
* optionally send an email when an issue is **resolved**
* optionally send a **reminder** only if issue remains unresolved for a long time

Recommended policy:

* immediate alert when issue first becomes active
* no repeat email for the same issue for 24 hours
* optional reminder after 24 hours, then every 48 hours
* optional recovery email when resolved

That avoids alert fatigue.

## 5. Use SendGrid, not EmailJS

Since your goal is operational monitoring, SendGrid is the better fit.

Use:

* a dedicated sender like `alerts@leadbridge360.com`
* one dynamic template for health alerts
* one dynamic template for recovery notices if you want them

Suggested email types:

### New issue

Subject:
`LeadBridge Alert — Token expired for Spotless Homes Tampa`

### Digest

Subject:
`LeadBridge Alert — 3 active issues`

### Recovery

Subject:
`LeadBridge Resolved — Spotless Homes Tampa reconnected`

SendGrid should be wired server-side, not from the frontend.

## 6. Dashboard and layout should read health API only

This part of the original plan is good in spirit, but should be stricter.

### Layout

Do not compute warning state from raw local account fields.
Instead call a server endpoint or use cached health state from your global query.

For example:

* if any active critical issue exists → show top warning banner
* banner text should be generic:

  * `Account issue detected — reconnect required`
  * or `System issue detected — review health panel`

### Dashboard

Use server health summary:

`GET /v1/monitoring/system-health`

Suggested response:

```json
{
  "healthy": false,
  "status": "critical",
  "lastCheckedAt": "2026-04-10T14:10:00Z",
  "summary": {
    "critical": 2,
    "warning": 1
  },
  "issues": [
    {
      "accountId": "...",
      "accountName": "Spotless Homes Tampa",
      "platform": "thumbtack",
      "issueCode": "token_expired",
      "status": "critical",
      "message": "Reconnect required",
      "firstDetectedAt": "...",
      "lastDetectedAt": "...",
      "lastNotifiedAt": "..."
    }
  ]
}
```

## 7. Add one more endpoint for history or details

Not required for v1, but useful:

* `GET /v1/monitoring/system-health`
* `GET /v1/monitoring/system-health/issues`
* `POST /v1/monitoring/system-health/run` for manual admin test

That manual run endpoint is extremely useful during debugging.

## 8. Add issue thresholds so you do not alert on transient failures

Some things should not alert instantly.

Recommended thresholds:

* `token_expired`: alert immediately once confirmed
* `webhook_missing`: alert immediately
* `notifications_disabled`: warning only, maybe no email unless explicitly expected
* `automation_failures`: alert only if threshold exceeded, for example:

  * 3+ unresolved failures in 1 hour
  * or failures across 2 consecutive health runs

This reduces noise.

## 9. Add cleanup/migration

The plan mentions one-time cleanup. Keep that.

Also do:

* backfill existing active incidents from recent unresolved logs if needed
* resolve stale historical duplicates

---

# My approved implementation order

## Phase 1 — Stabilize signal

1. Deduplicate `SystemErrorLog`
2. Route all direct error inserts through `MonitoringService.captureError`
3. Introduce structured issue codes

## Phase 2 — Add real health model

4. Add `AccountHealthStatus` table
5. Build hourly health cron
6. Upsert active/resolved health incidents

## Phase 3 — Notifications

7. Replace EmailJS with SendGrid
8. Send alerts on issue open
9. Add reminder throttle
10. Optional recovery email

## Phase 4 — UI

11. Add `GET /v1/monitoring/system-health`
12. Dashboard uses server summary
13. Layout banner uses server health only

## Phase 5 — Admin/testing

14. Add manual “run health check now” endpoint
15. Add test scenario for dead token / missing webhook / recovery

---

# Refactored AI-agent task

You can give this to the agent:

## System Health Monitor — Refactored Implementation Task

### Goal

Build a server-side health monitoring system for LeadBridge that:

* detects broken integrations automatically
* stores current health state independently from error logs
* sends SendGrid email alerts when issues appear
* prevents duplicate error spam
* drives the dashboard and layout warning banners from server health state

### Requirements

#### 1. Error log dedup

Update `MonitoringService.captureError()` so repeated unresolved errors do not create duplicate rows.

Use a dedup fingerprint based on:

* `category`
* `accountId`
* `code`
* optional `platform`

If an unresolved matching error exists, update its `lastSeenAt` / timestamp instead of inserting a new row.

Refactor all direct `prisma.systemErrorLog.create(...)` calls in `PlatformService` to use `this.monitoring.captureError(...)`.

#### 2. Add health state table

Create a new table, e.g. `AccountHealthStatus`, with fields:

* `id`
* `userId`
* `accountId`
* `platform`
* `status` (`healthy`, `warning`, `critical`)
* `issueCode`
* `issueMessage`
* `metadata` JSON
* `isActive`
* `firstDetectedAt`
* `lastDetectedAt`
* `lastCheckedAt`
* `resolvedAt`
* `lastNotifiedAt`
* `notificationCount`

This table is the source of truth for current health, not `SystemErrorLog`.

#### 3. Hourly health cron

In `MonitoringService`, add:

* `@Cron('10 * * * *')`
* advisory lock `7003`

For each saved account, evaluate health and upsert incidents in `AccountHealthStatus`.

Checks:

* token expired / invalid
* webhook missing
* notification routing missing or disabled
* repeated automation failures in last 24h
* optional: stale sync / no successful activity for abnormal duration

When an issue is no longer present, mark the health record resolved.

#### 4. Notification behavior

Use **SendGrid**, not EmailJS.

Implement alerting rules:

* send email when a new active issue is opened
* do not resend the same issue more than once within 24 hours
* optional reminder for unresolved issues after 24 hours
* optional recovery email when issue resolves

Send one grouped email per user per run if multiple new issues are detected.

#### 5. Health API

Add:

* `GET /v1/monitoring/system-health`

Response should include:

* overall healthy boolean
* overall status
* lastCheckedAt
* grouped issues for the current user
* summary counts by severity

Optional:

* `POST /v1/monitoring/system-health/run` for admin/manual testing

#### 6. Frontend integration

Update `Layout.tsx`:

* stop using local platform field heuristics
* show warning banner from server health summary

Update `Dashboard.tsx`:

* fetch `GET /v1/monitoring/system-health`
* show real server health state
* replace “ALL GOOD” client-only logic

#### 7. Cleanup

Add a one-time migration or script to:

* collapse duplicate unresolved historical errors
* optionally backfill current health incidents from recent known failures

### Files to modify

* `src/monitoring/monitoring.service.ts`
* `src/monitoring/monitoring.controller.ts`
* `src/platforms/platform.service.ts`
* `frontend/src/components/Layout.tsx`
* `frontend/src/pages/Dashboard.tsx`
* `frontend/src/services/api.ts`
* Prisma schema + migration for `AccountHealthStatus`

### Advisory locks

* `7001`: follow-up scheduler
* `7002`: proactive token refresh
* `7003`: system health check

### Verification

1. Expire a Thumbtack token manually
2. Run health cron or wait for hourly schedule
3. Confirm:

   * one active `token_expired` health incident exists
   * one SendGrid alert email is sent
   * dashboard shows unhealthy state
   * layout banner shows warning
   * duplicate unresolved error rows do not accumulate
4. Reconnect account
5. Confirm:

   * health incident resolves
   * dashboard returns to healthy
   * optional recovery email is sent

---

## Bottom line

I would say:

* **approve the direction**
* **do not approve the implementation details as written**
* refactor around **explicit health state + SendGrid + event-based notifications**

The one sentence version: **monitoring should be built as a status system, not as a prettier error log.**

