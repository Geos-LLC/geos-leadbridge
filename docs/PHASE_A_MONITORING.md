# Phase A — 24–48h Post-Deploy Monitoring Checklist

Run these checks at **T+1h**, **T+6h**, **T+24h**, and **T+48h** after Phase A lands on staging (and again after production deploy when that happens). Log results in a shared doc or Slack thread.

**Grafana wake step** (the instance sleeps after inactivity):
```bash
curl -s "https://info3d7b.grafana.net/api/org" -H "Authorization: Bearer $TOKEN" > /dev/null
```

**Token retrieval**:
```bash
TOKEN=$(aws secretsmanager get-secret-value --secret-id geos-dashboard-tokens --region us-east-1 \
  --query 'SecretString' --output text | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).GRAFANA_SA_TOKEN))")
```

---

## 1. Structured-log counts (Loki)

Count each of the four Phase A structured log tags over the monitoring window. Use `query_range` with `step=1h` for 24h buckets, or a single query for the whole window.

### Count `[yelp_event_fetch_failed]`

Spikes indicate Yelp API instability or token problems. Expected: near-zero baseline; occasional single-digit blips normal.

```bash
curl -s -G "https://info3d7b.grafana.net/api/datasources/proxy/7/loki/api/v1/query_range" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'query=count_over_time({service_name="leadbridge-api"} |= "[yelp_event_fetch_failed]" [1h])' \
  --data-urlencode "start=$(date -d '24 hours ago' -Iseconds)" \
  --data-urlencode "end=$(date -Iseconds)" \
  --data-urlencode 'step=3600' | jq '.data.result[0].values'
```

**Threshold**: > 20/h sustained → investigate Yelp token health or rate limit.

### Count `[yelp_event_reconciliation_scheduled]`

Should be ≤ the fetch_failed count (reconciliation only scheduled when we have an eventId to mark).

```bash
curl -s -G "https://info3d7b.grafana.net/api/datasources/proxy/7/loki/api/v1/query_range" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'query=count_over_time({service_name="leadbridge-api"} |= "[yelp_event_reconciliation_scheduled]" [1h])' \
  --data-urlencode "start=$(date -d '24 hours ago' -Iseconds)" \
  --data-urlencode "end=$(date -Iseconds)" \
  --data-urlencode 'step=3600' | jq '.data.result[0].values'
```

**Anomaly**: `reconciliation_scheduled > fetch_failed` → bug (should be ≤). `reconciliation_scheduled ≪ fetch_failed` → check why eventId is missing from webhook payloads.

### Count `[customer_reply_detected]`

Baseline: roughly matches your actual Yelp customer reply volume. Compare with `SELECT COUNT(*) FROM messages WHERE platform='yelp' AND sender='customer' AND "sentAt" > <window_start>`.

```bash
curl -s -G "https://info3d7b.grafana.net/api/datasources/proxy/7/loki/api/v1/query_range" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'query=count_over_time({service_name="leadbridge-api"} |= "[customer_reply_detected]" [1h])' \
  --data-urlencode "start=$(date -d '24 hours ago' -Iseconds)" \
  --data-urlencode "end=$(date -Iseconds)" \
  --data-urlencode 'step=3600' | jq '.data.result[0].values'
```

**Cross-check**: Loki count should be ≥ DB row count (Loki logs every detection including fail-open cases; DB has only successfully persisted messages).

### Count `[echo_confirmed]`

Baseline: roughly matches your outbound Yelp message volume (every AI/manual send echoes back once). Compare with `SELECT COUNT(*) FROM messages WHERE platform='yelp' AND sender='pro' AND "sentAt" > <window_start>`.

```bash
curl -s -G "https://info3d7b.grafana.net/api/datasources/proxy/7/loki/api/v1/query_range" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'query=count_over_time({service_name="leadbridge-api"} |= "[echo_confirmed]" [1h])' \
  --data-urlencode "start=$(date -d '24 hours ago' -Iseconds)" \
  --data-urlencode "end=$(date -Iseconds)" \
  --data-urlencode 'step=3600' | jq '.data.result[0].values'
```

**Anomaly**: `echo_confirmed ≫ outbound_count` → duplicate webhook delivery (should be handled by existing dedup, but flag). `echo_confirmed ≪ outbound_count` → some echoes misclassified as customer (silently costing follow-up stops) — **most important signal for the Decision 4 verification**.

---

## 2. Leads with reconciliation attempts ≥ 3

These are webhook events where classification retried 3+ times without succeeding — likely stuck tokens or dead businesses.

```sql
SELECT
  id,
  "receivedAt",
  "processingError",
  substring(payload, 1, 200) AS payload_preview
FROM webhook_events
WHERE platform = 'yelp'
  AND "processingError" ~ '^reconcile:yelp:.*:attempts=([3-9]|[1-9][0-9])'
ORDER BY "receivedAt" DESC
LIMIT 50;
```

**For each row**: inspect the `processingError` marker (has `<leadId>:<businessId>:<reason>`) and check:
- Is the account's token dead? (`SELECT * FROM saved_accounts WHERE "businessId" = '<id>' AND platform = 'yelp'` → decrypt `credentialsJson`, check `expiresAt`)
- Is there a `SystemErrorLog` entry for token refresh failure on this account in the same window?

Expected after 48h: **< 5 rows**. Anything higher means reconciliation is failing repeatedly; likely needs a user to reconnect their Yelp account.

---

## 3. Follow-up sent AFTER `Lead.lastCustomerActivityAt`

The critical correctness check: **a follow-up should never go out to a lead whose customer has spoken since the enrollment started.** If any do, the self-heal is not doing its job.

```sql
SELECT
  e.id AS enrollment_id,
  l.id AS lead_id,
  l."customerName",
  l.platform,
  l."lastCustomerActivityAt",
  se.id AS step_execution_id,
  se."stepIndex",
  se."executedAt" AS follow_up_sent_at,
  se.status,
  EXTRACT(EPOCH FROM (se."executedAt" - l."lastCustomerActivityAt")) / 60 AS minutes_after_customer_activity
FROM "FollowUpStepExecution" se
JOIN "FollowUpEnrollment" e ON e.id = se."enrollmentId"
JOIN leads l ON l.id = e."leadId"
WHERE se.status = 'sent'
  AND se."executedAt" IS NOT NULL
  AND l."lastCustomerActivityAt" IS NOT NULL
  AND se."executedAt" > l."lastCustomerActivityAt"
  AND se."executedAt" > NOW() - INTERVAL '48 hours'
ORDER BY minutes_after_customer_activity DESC
LIMIT 50;
```

**Expected**: **zero rows**. Every row is a Phase A failure (scheduler shipped a follow-up after the customer had already replied).

**If you find rows**:
1. Is the enrollment's `createdAt` AFTER the `lastCustomerActivityAt`? If so, it's a new enrollment after the customer went quiet again — not a Phase A bug (that's resume-after-silence behavior deferred to Phase C).
2. Otherwise — capture the enrollment id, lead id, timestamps, and file an issue. The self-heal check at [src/follow-up-engine/follow-up-scheduler.service.ts:381](src/follow-up-engine/follow-up-scheduler.service.ts#L381) did not fire.

Refined query excluding legitimate post-enrollment cases:

```sql
SELECT
  e.id AS enrollment_id,
  l.id AS lead_id,
  l."lastCustomerActivityAt",
  se."executedAt" AS follow_up_sent_at,
  e."createdAt" AS enrollment_created_at
FROM "FollowUpStepExecution" se
JOIN "FollowUpEnrollment" e ON e.id = se."enrollmentId"
JOIN leads l ON l.id = e."leadId"
WHERE se.status = 'sent'
  AND l."lastCustomerActivityAt" > e."createdAt"      -- activity happened during this enrollment
  AND se."executedAt" > l."lastCustomerActivityAt"    -- BUT follow-up still fired after
  AND se."executedAt" > NOW() - INTERVAL '48 hours';
```

---

## 4. Reconciliation outcome distribution

After the reconcile cron has run a few cycles, check what outcomes are most common.

```sql
SELECT
  CASE
    WHEN "processingError" LIKE 'reconcile:yelp:%' THEN 'pending'
    WHEN "processingError" LIKE 'reconciled:customer:%' THEN 'reconciled:customer'
    WHEN "processingError" LIKE 'reconciled:echo:%' THEN 'reconciled:echo'
    WHEN "processingError" LIKE 'reconciled:no_account:%' THEN 'reconciled:no_account'
    WHEN "processingError" LIKE 'reconciled:max_attempts:%' THEN 'reconciled:max_attempts'
    ELSE 'other'
  END AS outcome,
  COUNT(*) AS count
FROM webhook_events
WHERE platform = 'yelp'
  AND "processingError" IS NOT NULL
  AND "processingError" LIKE ANY(ARRAY['reconcile:%', 'reconciled:%'])
  AND "receivedAt" > NOW() - INTERVAL '48 hours'
GROUP BY outcome
ORDER BY count DESC;
```

**This is the Decision 4 verification data**: what ratio of fail-opens were actually customer vs echo? Use it to confirm the fail-open direction was correct before kicking off Phase B.

Expected (based on typical distributions):
- `reconciled:echo`: dominates → fail-open was WRONG direction; revisit Decision 4 before Phase B.
- `reconciled:customer`: dominates → fail-open was RIGHT; green-light Phase B planning.
- Roughly equal → fail-open still defensible (asymmetric failure cost); green-light Phase B but watch.

---

## Pass/fail summary template

Copy this into your monitoring thread after each checkpoint:

```
## Phase A monitoring — T+<N>h (<date>)

### Log counts (last <N>h)
- [yelp_event_fetch_failed]: <count>
- [yelp_event_reconciliation_scheduled]: <count>
- [customer_reply_detected]: <count>
- [echo_confirmed]: <count>

### DB checks
- Webhook events with attempts ≥ 3: <count>  (any concerning? Y/N)
- Follow-ups sent after lastCustomerActivityAt (refined query): <count>  (should be 0)
- Reconcile outcome dist: customer=<n> / echo=<n> / max_attempts=<n> / no_account=<n>

### Decision 4 verdict (only needed at T+48h)
- Fail-open direction: correct / revisit (justification: ...)

### Incidents
- <any anomalies observed, e.g. "2 follow-ups sent after reply on lead X — investigating">
```

---

## Escalation triggers

Page / revert Phase A if any of these happen:

1. **`fetch_failed` rate > 100/h sustained** for more than 1 hour → Yelp API may be returning intermittent errors that our fail-open policy is compounding.
2. **Refined "follow-ups after customer activity" query returns > 5 rows** in any 24h window → self-heal is broken.
3. **Any user-reported complaint** about receiving a follow-up after they'd replied → high-priority; correlate with the DB query above.
4. **Railway boot logs show startup errors** related to `FollowUpSchedulerService` or `WebhooksService` constructor injection → PlatformsModule wiring broken.

Revert = set `CACHE_ENABLED` (if flipped later), rollback phase-a-deploy via `git revert <commit>` + push `main` (for production) or re-merge origin/staging's prior tip (for staging).
