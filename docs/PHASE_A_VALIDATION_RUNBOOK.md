# Phase A — Staging Validation Runbook

Three scenarios to run against staging after the Phase A deploy lands. Each scenario lists the trigger, the expected observable behavior, the Loki queries to confirm the structured logs, and the DB queries to confirm state.

**Staging service**: `sigcore-staging.up.railway.app` (backend) + `service_name="leadbridge-api"` in Loki.
**Relevant logs stream**:

```logql
{service_name="leadbridge-api"} |~ "yelp_event_fetch_failed|yelp_event_reconciliation_scheduled|customer_reply_detected|echo_confirmed|classifyYelpNewEvent|reconcileYelpEvents"
```

**Loki endpoint** (per global CLAUDE.md):
```
https://info3d7b.grafana.net/api/datasources/proxy/7/loki/api/v1/query_range
```

Token retrieval:
```bash
TOKEN=$(aws secretsmanager get-secret-value --secret-id geos-dashboard-tokens --region us-east-1 \
  --query 'SecretString' --output text | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).GRAFANA_SA_TOKEN))")
```

---

## Scenario 1 — Yelp customer replies after first message

**Trigger (manual)**: use the Yelp test business ("Plumbing Business Tester - Test", `SNa1ugk6DNIuvIPu8-AiGA`). Create a new lead; as the "customer" side, send a reply through Yelp's consumer UI.

### Expected observable behavior
1. Webhook arrives at LeadBridge → `WebhookEvent` row created (platform='yelp', eventType='NEW_EVENT').
2. Classification runs → `[customer_reply_detected] yelp lead=<id> outcome=customer ...` log.
3. Inbound message **persists to `Message`** with `sender='customer'`, `senderType='customer'`, `platform='yelp'`, `externalMessageId` = Yelp event id.
4. **`Lead.lastCustomerActivityAt`** bumped to the event time.
5. Any active `FollowUpEnrollment` for the conversation gets **stopped** with `stoppedReason='customer_replied'` (via `followUpEngine.handleCustomerReply()` or next scheduler tick via self-heal).
6. **No follow-up message sent** after the customer reply (confirmed by absence of new `FollowUpStepExecution` rows for this conversation with `status IN ('sent','suggested')` after the reply timestamp).

### Loki query (last 15 min)
```logql
{service_name="leadbridge-api"} |~ "customer_reply_detected|ensureMessagePersisted|customer_replied"
```

### DB verification (Supabase SQL or Prisma Studio)
```sql
-- 1. Message row exists for the Yelp event
SELECT id, "conversationId", sender, "senderType", "externalMessageId", "sentAt", substring(content, 1, 80) AS preview
FROM messages
WHERE platform = 'yelp' AND "externalMessageId" = '<yelp_event_id>';

-- 2. Lead.lastCustomerActivityAt bumped
SELECT id, "customerName", "lastCustomerActivityAt"
FROM leads
WHERE "externalRequestId" = '<yelp_lead_id>' AND platform = 'yelp';

-- 3. Active enrollment stopped
SELECT id, status, "stoppedReason", "completedAt"
FROM "FollowUpEnrollment"
WHERE "conversationId" = '<conv_id>' ORDER BY "createdAt" DESC LIMIT 5;

-- 4. No new step executions after the customer activity timestamp
SELECT id, "stepIndex", status, "executedAt"
FROM "FollowUpStepExecution" e
JOIN "FollowUpEnrollment" f ON f.id = e."enrollmentId"
WHERE f."conversationId" = '<conv_id>' AND e."executedAt" > <customer_reply_at>
ORDER BY e."executedAt" DESC;
```

**PASS** = row 1 exists, row 2 populated, row 3 status='stopped' with reason='customer_replied', row 4 empty.

---

## Scenario 2 — Yelp customer replies **quickly** after AI/pro message

**Trigger (manual)**: ensure AI Conversation is enabled on the test account. Customer sends initial message → AI auto-replies → within 10–60 seconds, customer sends another reply.

This is the scenario that the **deleted 90-second fallback would have misclassified as an echo**.

### Expected observable behavior
1. First Yelp webhook (customer's initial) → classified `outcome=customer`, persisted.
2. AI reply fires → Yelp echo webhook arrives → classified `outcome=echo` (latest event is `user_type=BIZ`) → `[echo_confirmed]` log → early return, NO persistence for the echo, NO false `handleCustomerReply` trigger.
3. Second customer reply arrives within 90s → classified `outcome=customer` (latest is CONSUMER) → persisted → **NOT silently swallowed as echo**.
4. Any active follow-up enrollment stopped by the second reply.

### Loki query
```logql
{service_name="leadbridge-api"} |~ "echo_confirmed|customer_reply_detected" | json
```

Count in the window: `echo_confirmed` should match each AI/manual pro send that bounced back; `customer_reply_detected` should match each real customer message. If you see fewer `customer_reply_detected` than actual customer sends — failure.

### DB verification
```sql
-- Every CONSUMER event from Yelp gets a Message row. Compare externalMessageId against Yelp's event_ids for the lead.
SELECT "externalMessageId", "sentAt", sender, substring(content, 1, 60)
FROM messages
WHERE "conversationId" = '<conv_id>' AND platform = 'yelp'
ORDER BY "sentAt" DESC LIMIT 20;
```

**PASS** = every customer message (within the test window) has a corresponding `sender='customer'` Message row; no Message rows with `sender='customer'` for events that were actually BIZ echoes.

---

## Scenario 3 — Yelp API/token failure during webhook

**Trigger (manual)**: the fastest safe repro is to force a 401 by temporarily poisoning the account's access token.

1. In Supabase: `UPDATE "saved_accounts" SET "credentialsJson" = 'poison' WHERE id = '<test_account_id>';` (keep the original value — you'll restore it).
2. As customer, send a Yelp message to trigger a NEW_EVENT webhook.
3. Wait ≤ 5 minutes, then restore the credentials and confirm reconciliation.

### Expected observable behavior
1. `getLeadEvents` throws (or returns empty due to auth failure) → `classifyYelpNewEvent` returns `outcome='unknown'`.
2. Log line `[yelp_event_fetch_failed] lead=<id> eventId=<id> reason=...`.
3. `markYelpEventForReconciliation()` runs → `WebhookEvent.processingError = 'reconcile:yelp:<leadId>:<businessId>:<reason>:attempts=0'`.
4. Log line `[yelp_event_reconciliation_scheduled] lead=<id> eventId=<id>`.
5. Webhook **proceeds fail-open**: treats event as customer reply → persists Message, stops enrollment. (Per Decision 4 in the plan doc — missing a real reply is worse than a false stop.)
6. Within 5 minutes, `reconcileYelpEvents()` cron fires → retries `getLeadEvents`. If token was restored, retry succeeds → marker updated to `reconciled:customer:<reason>` or `reconciled:echo:<reason>`. If still broken, marker becomes `reconcile:...:attempts=1`.
7. After 5 attempts (~25 min), marker caps at `reconciled:max_attempts:<reason>`.

### Loki queries
```logql
# Fetch-fail trail
{service_name="leadbridge-api"} |~ "yelp_event_fetch_failed|yelp_event_reconciliation_scheduled"

# Reconcile cron activity
{service_name="leadbridge-api"} |~ "reconcileYelpEvents|Yelp event reconciled|Yelp event reconcile capped"
```

### DB verification
```sql
-- Reconciliation marker on the webhook event
SELECT id, "receivedAt", "eventType", "processingError"
FROM webhook_events
WHERE platform = 'yelp' AND "processingError" LIKE 'reconcile:yelp:%'
ORDER BY "receivedAt" DESC LIMIT 10;

-- After cron retry (5 min later)
SELECT id, "receivedAt", "processingError"
FROM webhook_events
WHERE platform = 'yelp' AND "processingError" LIKE 'reconciled:%'
ORDER BY "receivedAt" DESC LIMIT 10;
```

**PASS** = you see `reconcile:yelp:...:attempts=0` shortly after the poisoned webhook, and `reconciled:customer:...` or `reconciled:echo:...` once credentials are restored. No AI reply fired in the fail-open window that would have mis-interpreted the fail-open decision (check `Message` table for `sender='pro' senderType='ai'` entries after the fail timestamp).

---

## Scenario 4 — Phase A doesn't break Thumbtack (regression spot-check)

Phase A only touched the Yelp webhook path, but shares code (`ensureMessagePersisted`, scheduler self-heal). Sanity check:

- Trigger a Thumbtack customer reply on any test account.
- `Message` row exists as before (Thumbtack's own persistence path, unchanged).
- Active enrollment stops on reply.
- No `[yelp_event_fetch_failed]` in Thumbtack logs (prefix is Yelp-scoped).

---

## Test-data hygiene

After validation:
- Restore any poisoned credentials.
- Optional: `DELETE FROM webhook_events WHERE "processingError" LIKE 'reconcil%' AND "receivedAt" > <test_start>;` to clean up.
- Leave Message rows — they represent real events and reconcile markers are audit-useful.
