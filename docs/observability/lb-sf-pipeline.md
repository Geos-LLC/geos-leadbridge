# LB ↔ SF Pipeline Observability Runbook

This document is a self-contained runbook for the LeadBridge ↔ Service Flow
lead-status pipeline. Anyone (operator, debugger, AI agent) should be able to
trace one event end-to-end and respond to an alert using only what's here.

---

## 1. Pipeline overview

```
                       ┌─────────────────────────────────────┐
                       │                                     │
                       │              ServiceFlow            │
                       │                                     │
                       └────────┬────────────────────▲───────┘
                                │ event_id (LB→SF)   │ event_id (SF→LB)
                                │                    │
                                ▼                    │
   ┌──────────────────────────────────────────────────────────────────┐
   │                                                                  │
   │  LeadBridge                                                      │
   │                                                                  │
   │   CrmWebhookService.emit()                                       │
   │     ├── buildPayload()  → payload.event_id = ctx.eventId || UUID │
   │     └── sendWebhook()   → CrmWebhookDelivery row keyed by event_id│
   │                                                                  │
   │   POST /v1/integrations/service-flow/job-status                  │
   │     ├── HMAC verify                                              │
   │     ├── SfInboundEvent row keyed by payload.event_id             │
   │     └── LeadStatusService.writeStatus({sourceEventId: event_id}) │
   │           └── LeadStatusAuditLog row.sourceEventId = event_id    │
   │                                                                  │
   └──────────────────────────────────────────────────────────────────┘
```

**The spine is `event_id`.** The same id is shared across:

- `CrmWebhookDelivery.eventId` (outbound)
- `SfInboundEvent.eventId` (inbound)
- `LeadStatusAuditLog.sourceEventId` (audit row written when SF event applies)
- All `[CrmWebhook]`, `[SfInbound]`, `[LeadStatus]` log lines

Loki service label: `service_name="leadbridge-api"`.

---

## 2. Trace one `event_id` end-to-end

Given `event_id=evt_abc123`:

### 2.1. Loki (logs)

```logql
{service_name="leadbridge-api"} |= "evt_abc123"
```

Expected lines, in order:

```
[CrmWebhook] event_id=evt_abc123 sub_id=… attempt=1 status_code=200 result=success
[SfInbound]  event_id=evt_abc123 lead_id=…   result=applied error=null status=…
[LeadStatus] event_id=evt_abc123 lead_id=…   source=service_flow result=applied …
```

If only some appear, the trace stopped at that step — see §6 alert meanings.

### 2.2. Database (authoritative state)

```sql
-- 1. Outbound delivery (LB → SF)
SELECT id, "subscriptionId", state, attempts, "lastStatusCode", "lastError", "deliveredAt"
FROM crm_webhook_deliveries
WHERE "eventId" = 'evt_abc123';

-- 2. Inbound event (SF → LB)
SELECT id, "leadId", "sfJobId", status, result, "processingError", "receivedAt"
FROM sf_inbound_events
WHERE "eventId" = 'evt_abc123';

-- 3. Audit row (status write)
SELECT id, "leadId", "oldStatus", "newStatus", source, conflict, "occurredAt"
FROM lead_status_audit_log
WHERE "sourceEventId" = 'evt_abc123';
```

### 2.3. Quick replay (admin endpoints)

For deferred / unmapped / dry-run inbound events:

```bash
# List recent SF inbound events for a user (JWT required)
GET  /api/v1/integrations/service-flow/events?status=deferred&limit=20

# Replay a stored event through the pipeline
POST /api/v1/integrations/service-flow/events/:id/replay
```

---

## 3. Health endpoint

```
GET /api/v1/integrations/health
```

Public, no auth. Cheap (5 parallel DB count queries).

```json
{
  "status": "ok",
  "lastInboundAt": "2026-04-29T19:44:09.936Z",
  "lastOutboundAt": null,
  "countsLast1h": {
    "applied": 0,
    "noop": 0,
    "failed": 0,
    "sf_protected": 0
  },
  "crm": { "5xx": 0, "failures": 0 },
  "alertsLast1h": {
    "inboundErrors": 0,
    "outboundFailures": 0,
    "crm5xx": 0
  },
  "dlq": 0
}
```

| Field | Source | Meaning |
|---|---|---|
| `lastInboundAt` | `MAX(sf_inbound_events.receivedAt)` | When SF last reached us. `null` = never. |
| `lastOutboundAt` | `MAX(crm_webhook_deliveries.deliveredAt)` where `state='sent'` | When we last delivered an outbound event successfully. `null` = never. |
| `countsLast1h.applied` | `sf_inbound_events.status='applied'` last 1h | Successful SF→LB writes |
| `countsLast1h.noop` | `sf_inbound_events.status='noop'` last 1h | Non-changes (status_unchanged, lead_status_skip) |
| `countsLast1h.failed` | `sf_inbound_events.processingError IS NOT NULL` last 1h | Inbound processing failures |
| `countsLast1h.sf_protected` | in-memory counter from `LeadStatusService` | `lb_automation` writes blocked because SF owns the lead's status. Resets on deploy. |
| `crm.5xx` | `crm_webhook_deliveries.lastStatusCode >= 500` last 1h | Receiver returned 5xx |
| `crm.failures` | `crm_webhook_deliveries.state='failed'` last 1h | Both delivery attempts failed |
| `alertsLast1h.*` | Same as the three counters above | Convenience block matching alert names |
| `dlq` | always `0` | Reserved for future retry queue (Phase 4+) |

---

## 4. Key Loki queries

```logql
# All pipeline activity for one event_id
{service_name="leadbridge-api"} |= "evt_abc123"

# Inbound errors last 24h
{service_name="leadbridge-api"} |~ "\\[SfInbound\\] .*result=(unauthorized|exception|unmapped_status)"

# Outbound delivery failures
{service_name="leadbridge-api"} |~ "\\[CrmWebhook\\] .*result=failed"

# All 5xx responses on outbound
{service_name="leadbridge-api"} |~ "\\[CrmWebhook\\] .*status_code=5"

# Skip-reason distribution from LeadStatusService
{service_name="leadbridge-api"} |~ "\\[LeadStatus\\] .*result=skipped" | regexp "skip_reason=(?P<reason>\\S+)"

# Pipeline health cron output
{service_name="leadbridge-api"} |= "[PipelineHealth]"

# Hourly cron success vs lock-skip
{service_name="leadbridge-api"} |= "[HealthCheck]"
```

---

## 5. Key DB queries

```sql
-- Outbound delivery success rate last 1h
SELECT state, COUNT(*) FROM crm_webhook_deliveries
WHERE "createdAt" > NOW() - INTERVAL '1 hour'
GROUP BY state;

-- Inbound result distribution last 24h
SELECT status, result, COUNT(*) FROM sf_inbound_events
WHERE "receivedAt" > NOW() - INTERVAL '24 hours'
GROUP BY status, result
ORDER BY COUNT(*) DESC;

-- Active pipeline alerts (deduped)
SELECT code, severity, "userId", message, "updatedAt"
FROM system_error_logs
WHERE category = 'webhook'
  AND code IN ('sf_inbound_stalled','crm_outbound_stalled',
               'sf_inbound_processing_error','crm_outbound_failed','crm_outbound_5xx')
  AND resolved = false
ORDER BY "updatedAt" DESC;

-- Subscriptions and last activity
SELECT id, "userId", name, direction, "isActive", "lastEventAt"
FROM crm_webhook_subscriptions
ORDER BY "lastEventAt" DESC NULLS LAST;
```

---

## 6. Alert meanings

All Phase 2 alerts are written to `system_error_logs` with `category='webhook'`.
Dedup is by `(category, userId, code, resolved=false)` — repeated cron runs
update the same row instead of creating new ones.

### `sf_inbound_processing_error` — severity `error`

**What:** One or more `sf_inbound_events.processingError` rows in the last 1h.
**Cause:** SF→LB request hit a hard failure: signature mismatch, missing
required fields, unknown SF status, ingest exception.
**Where to look:**
```sql
SELECT "eventId", status, result, "processingError", "receivedAt"
FROM sf_inbound_events
WHERE "processingError" IS NOT NULL
ORDER BY "receivedAt" DESC LIMIT 20;
```
Loki: `{service_name="leadbridge-api"} |~ "\\[SfInbound\\].*result=(unauthorized|exception|unmapped_status)"`

**Common fixes:** rotate the SF subscription secret if `signature_mismatch`;
extend `sf-status-map.ts` if `unmapped_status`; restart the service if
`exception` is a transient bug.

### `crm_outbound_failed` — severity `error`

**What:** One or more `crm_webhook_deliveries.state='failed'` rows in the last
1h. State='failed' means BOTH attempts (10s + 15s) failed.
**Cause:** Receiver was unreachable, timed out, returned non-2xx on both
tries, or returned an HMAC-rejected response.
**Where to look:**
```sql
SELECT "subscriptionId", "eventType", "lastStatusCode", "lastError", attempts, "createdAt"
FROM crm_webhook_deliveries
WHERE state = 'failed'
ORDER BY "createdAt" DESC LIMIT 20;
```
**Common fixes:** check the receiver's status; verify `webhookUrl` on the
subscription; check the secret is in sync.

### `crm_outbound_5xx` — severity `error`

**What:** One or more deliveries where `lastStatusCode >= 500` in the last 1h.
Includes both single-attempt 5xx (still `state='pending'` after retry kicks
in) and final-failure 5xx.
**Cause:** Receiver is unhealthy.
**Action:** Page receiver owner. Phase 1 has no retry worker, so any
5xx-then-success only happens within the in-flight 1-retry window.

### `sf_inbound_stalled` — severity `warning`

**What:** An active inbound subscription with `lastEventAt` previously set
hasn't received an event in >24h.
**Cause:** SF stopped sending us events. Reasons: SF outage, SF unsubscribed,
signature drift causing receiver-side rejection, network partition.
**Action:** Verify SF is still configured to send to LeadBridge; verify the
subscription is still active; replay a known event with curl.

The "previous traffic" gate — only firing if `lastEventAt IS NOT NULL` AND a
prior `SfInboundEvent` exists for the subscription — prevents alerts on
freshly-registered subscriptions that haven't received their first event yet.

### `crm_outbound_stalled` — severity `warning`

**What:** An active outbound subscription with at least one prior successful
delivery (`state='sent'`) hasn't delivered anything in >24h.
**Cause:** No outbound events were emitted for this user — could be normal if
the user has no recent leads or messages, OR could mean the emit path is
broken (e.g. loop guard suppressing everything).
**Action:** Check `system_error_logs` for the same userId for related
issues; verify the user's accounts are still active.

---

## 7. Manual integrity check

```bash
DATABASE_URL=$DIRECT_URL node scripts/integrity-check-pipeline.js
```

Five checks:

1. `Lead.status` outside the canonical set
2. `platformStatus` set but `Lead.status` is legacy/raw (drift)
3. SF-linked leads with `statusSource ∉ {service_flow, manual}` (bypass signal)
4. `sf_inbound_events.processingError` last 24h
5. `crm_webhook_deliveries` failed/5xx last 24h

Exit codes: 0 clean / 1 drift or errors / 2 script error. Designed to be cron-able later if it proves stable.

Canonical status set lives in [`src/leads/canonical-status.ts`](../../src/leads/canonical-status.ts) — keep the script's hardcoded list in sync.

---

## 8. Rollback steps

The Phase 1 + 2 change set is **observability only** — no runtime behavior
was modified. Rolling back is safe.

### Code rollback

```bash
# Last commit before Phase 1
git checkout d17b406 -- prisma/schema.prisma \
                        src/app.module.ts \
                        src/crm-webhooks/crm-webhook.service.ts \
                        src/integrations/service-flow/service-flow-inbound.controller.ts \
                        src/integrations/service-flow/sf-inbound-status.service.ts \
                        src/leads/lead-status.service.ts \
                        src/monitoring/monitoring.service.ts
git rm -r src/integrations/health prisma/migrations/20260501000000_add_crm_webhook_delivery_and_processing_error
git rm src/monitoring/pipeline-health.service.spec.ts
```

### Database rollback (only if a column is causing problems — none expected)

```sql
-- Drop the new outbound delivery table
DROP TABLE IF EXISTS crm_webhook_deliveries;

-- Drop the inbound processing-error column
ALTER TABLE sf_inbound_events DROP COLUMN IF EXISTS "processingError";
```

The SystemErrorLog rows written by Phase 2 are namespaced by `code` and can
be left in place or resolved via the existing admin endpoint:

```bash
DELETE FROM system_error_logs
WHERE category = 'webhook'
  AND code IN ('sf_inbound_stalled','crm_outbound_stalled',
               'sf_inbound_processing_error','crm_outbound_failed','crm_outbound_5xx');
```

### Disable the pipeline cron without rolling back code

```ts
// In MonitoringService.systemHealthCheck, comment out:
// await this.runPipelineHealthChecks();
```

Or set `SF_INBOUND_WEBHOOK_ENABLED=false` to silence inbound entirely (which
also makes `[SfInbound]` log lines stop, eliminating any noise).

---

## 9. Known caveats

- **Hourly cron + advisory lock 7003 + pgbouncer.** Both staging and prod
  attempt the cron at `:10`; one wins the lock and runs the four pipeline
  checks. With pgbouncer transaction-mode pooling, the session-scoped
  advisory lock can occasionally outlive its session, causing a cycle where
  *both* instances log `[HealthCheck] Another instance holds the lock —
  skipping`. Average over 24h: ~16 successful runs. Pre-existing — predates
  Phase 2.

- **`lastOutboundAt: null` until first successful CRM delivery.** Brand-new
  installs will see `null` here until the first outbound webhook fires.
  Not an alert condition.

- **In-memory `sf_protected` counter resets on deploy.** Use the audit log
  for historical analysis instead.
