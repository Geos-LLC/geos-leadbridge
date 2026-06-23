# LeadBridge Operational Scripts

One-off Node scripts for diagnostics, audits, backfills, and tenant recovery.

> **Connection rule:** every script reads `DIRECT_URL` from env. Source it from prod via:
>
> ```bash
> RAILWAY_TOKEN=$(aws secretsmanager get-secret-value --secret-id geos-dashboard-tokens \
>   --region us-east-1 --query 'SecretString' --output text \
>   | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).RAILWAY_TOKEN))")
> curl -s "https://backboard.railway.com/graphql/v2" \
>   -H "Authorization: Bearer $RAILWAY_TOKEN" -H "Content-Type: application/json" \
>   -d '{"query":"query { variables(projectId: \"af5d4f09-6bb6-49c6-ae0c-cf72fda35c88\", environmentId: \"69d744fa-6fc4-48b3-83c9-4aac67a6081a\", serviceId: \"d59d2d4c-816a-4639-9687-8e0ec7b487cf\") }"}' \
>   | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const v=JSON.parse(d).data.variables;console.log('export DIRECT_URL=\"'+v.DIRECT_URL+'\"');console.log('export SIGCORE_API_URL=\"'+v.SIGCORE_API_URL+'\"');console.log('export SIGCORE_API_KEY=\"'+v.SIGCORE_API_KEY+'\"');console.log('export APP_BASE_URL=\"'+v.APP_BASE_URL+'\"');})" > .tmp_durl
> source .tmp_durl
> ```
>
> Delete `.tmp_durl` after the work is done — `SIGCORE_API_KEY` is a workspace key.

## Tenant config audits

These are read-only.

### `_audit-tenant-config-matrix.js`
Side-by-side config matrix for every tenant vs the two working references (Spotless, Lavanda). Columns: account count, businessPhone set, business-hours on, AI on, active TPN count, NS enabled/dest/key/inboundHook/customer-texting counts, CC enabled/agent-phone counts, rule counts, plus 14-day activity (leads, notifications, CC sessions, trial-ended state).

**Use when:** you suspect a class of tenants is silently broken, want to spot outliers vs the reference configuration, or want to verify a backfill landed.

```bash
node scripts/_audit-tenant-config-matrix.js
```

### `_audit-intent-per-tenant.js`
Per-tenant intent dump for a targeted list — user-level toggles (AI, biz hours, quiet hours), onboarding wizard answers, per-account follow-up mode, full NotificationSettings + rule names, CallConnectSettings, and TPNs.

**Use when:** the matrix flags a tenant as anomalous and you need to separate "user turned X off on purpose" from "X is supposed to be on but the config is broken." Edit the `TARGETS` array at the top to scope the dump.

```bash
node scripts/_audit-intent-per-tenant.js
```

## Backfills (idempotent — safe to re-run)

### `_backfill-ns-userid-and-cc.js`
Fills the three regressions from the 2026-06-23 audit:
1. NS rows where `userId IS NULL` → set from `SavedAccount.userId`
2. NS rows where `destinationPhone IS NULL` → set from `User.businessPhone`
3. SavedAccounts with no CallConnectSettings → seed defaults with `agentPhoneE164` pre-filled from `User.businessPhone`

Filters mean re-runs are no-ops once everything is fixed.

```bash
DRY_RUN=1 node scripts/_backfill-ns-userid-and-cc.js   # preview
node scripts/_backfill-ns-userid-and-cc.js             # apply
```

## Tenant recovery (one-off per account)

### `_provision-account-ns.js`
Creates a missing NotificationSettings row for a SavedAccount that has none. Calls Sigcore `/tenants/provision` to allocate a tenant key + workspace, then creates the NS row with `userId`, `destinationPhone` from the owner, and clones rules from a sibling SavedAccount (most-recently-used one with rules) if available.

**Use when:** a SavedAccount has no NS row at all (pre-2026-06-23 onboarding before `autoProvisionSigcore` was hardened). For NS rows that exist but have null fields, use `_backfill-ns-userid-and-cc.js` instead.

```bash
SAVED_ACCOUNT_ID=<uuid> DRY_RUN=1 node scripts/_provision-account-ns.js  # preview
SAVED_ACCOUNT_ID=<uuid> node scripts/_provision-account-ns.js            # apply
# Optional: SIBLING_SAVED_ACCOUNT_ID=<uuid> to override the rule-source pick
```

### `_register-inbound-sms-webhook.js`
Registers the Sigcore inbound-SMS webhook subscription for a SavedAccount whose `NS.inboundSmsWebhookId` is null. Mirrors `notifications.service.ts:ensureInboundSmsWebhook()` but as a one-off.

As of 2026-06-23 `autoProvisionSigcore` calls this automatically for every new SavedAccount, so this script is only needed for pre-fix tenants or manual recovery.

```bash
SAVED_ACCOUNT_ID=<uuid> DRY_RUN=1 node scripts/_register-inbound-sms-webhook.js
SAVED_ACCOUNT_ID=<uuid> node scripts/_register-inbound-sms-webhook.js
```

## Recovery playbook: "tenant says LeadBridge isn't working"

1. **Run the config matrix** to spot which row is anomalous vs Spotless / Lavanda.
2. **Run the intent dump** for that tenant (add their email to `TARGETS` in `_audit-intent-per-tenant.js`) to read what they configured. Distinguish user-choice (AI off intentionally) from broken seed.
3. **Check the trial gate** — `trialEndedAt`, `subscriptionTier`, `subscriptionStatus`. A "config looks fine but nothing fires" tenant is most often paywalled.
4. **Match the symptom to a fix:**
   - NS row missing entirely → `_provision-account-ns.js`
   - NS missing `inboundSmsWebhookId` → `_register-inbound-sms-webhook.js`
   - NS missing `userId` or `destinationPhone`, or CC missing `agentPhoneE164` → `_backfill-ns-userid-and-cc.js`
5. **Re-run the matrix** to confirm the row turned green.

## Notes for future scripts

- Use `generated/prisma` (not `@prisma/client`) — that's the project's generated location.
- Always parameterize via env vars (`SAVED_ACCOUNT_ID=…`), not hardcoded UUIDs. The earlier scripts that hardcoded a tenant ID got renamed because they couldn't be reused.
- Support `DRY_RUN=1` for anything that writes — both DB and external APIs (Sigcore).
- Never echo `SIGCORE_API_KEY` or any other secret in output. Print length, not value.
- Filter by symptom (e.g. `destinationPhone: null`), not by tenant — so re-runs are idempotent.
