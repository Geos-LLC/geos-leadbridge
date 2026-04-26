# Phone Allocation Guard Fix — Superseded (2026-04-24)

> **This document is retained for history only.** The original plan below specified guards and enforcement for the three-phone-type model (Pool / BYO OpenPhone / Dedicated). That model no longer exists.

---

## What happened

PRs #104, #105, #106 collapsed the phone-routing model to **dedicated-only**:

- **Pool numbers** (shared platform-owned phones): deleted. The `PhonePool` and `PhonePoolAssignment` tables + `admin-phone-pool.service.ts` routing code are gone. Production had 0 rows in these tables.
- **BYO OpenPhone** (tenant-connected OpenPhone numbers): deleted. `NotificationSettings.sigcoreFromPhone`, `sigcoreProvider`, and `sigcoreWebhookId` columns are dropped. `connectProviderViaSigcore`, `disconnectProviderViaSigcore`, `fetchOpenPhoneNumbers`, `connectSigcore`, and `disconnectSigcore` helpers are deleted. Production had 0 OpenPhone tenants.
- **Dedicated numbers** (`TenantPhoneNumber`): the only remaining model. Resolved by `resolveBotPhone(userId, savedAccountId)` in `notifications.service.ts`. Tenant Sigcore API key always used.

Because pool and BYO paths no longer exist, most of the guards below are structurally impossible to violate:

| Original guard | Current status |
|---|---|
| Pool blocked from customer SMS | ✅ Vacuous — no pool |
| OpenPhone blocked from tenant alerts | ✅ Vacuous — no OpenPhone routing |
| Call-connect restricted to dedicated | ✅ Only dedicated exists |
| `resolveFromPhoneContext` returning type + keyMode | ✅ Collapsed: always `type=DEDICATED`, `provider=twilio`, `keyMode=TENANT` |
| Pool sends use platform key; tenant sends use tenant key | ✅ Collapsed: always tenant key |

## What to read instead

- `PHONE_NUMBER_SPEC.md` — current dedicated-only spec with the business-vs-dedicated distinction.
- `DB_STRUCTURE.md` — current schema (after PR #106 drops).
- `ARCHITECTURE_SPEC.md` — current architectural rules.

## What's still live that looked similar in the old plan

**Sigcore call-connect ownership guard (PART B, B3 in the original plan)** — `assertNumberOwnedByBusiness` equivalent is still relevant. In LeadBridge, per-business webhook subscriptions are scoped via the `accountId` query param on `/webhooks/sigcore/call-connect` and verified with per-business HMAC secrets (`CallConnectSettings.sigcoreWebhookSecret`). The principle — "don't route a call by global `WHERE botNumber = X` alone" — still holds.

---

<details>
<summary>Historical plan text (click to expand)</summary>

The original plan, written against the three-type model, is preserved below for archaeology. Do not implement anything from it without first checking whether the premise still applies.

### Context

We had 3 phone types:

1. **Pool (shared, platform-owned)** — tenant alerts only, cross-tenant allowed
2. **BYO OpenPhone (tenant-owned)** — customer SMS allowed; alerts only if to≠from; no call-connect
3. **Dedicated Twilio (tenant-owned)** — customer SMS, alerts, forwarding, call-connect allowed

### Goals

- `resolveFromPhoneContext(tenantId, fromPhoneE164)` → `{ type, provider, sigcoreKeyMode, ... }`
- Guards: pool blocked from customer SMS; OpenPhone blocked from alerts; forwarding requires dedicated; no fallback to platform key for tenant ops.
- Sigcore changes: pool numbers never recorded as tenant allocations; call-connect is dedicated-only; ownership guard on call-connect routing.

### Resolution

The entire three-type model was removed on 2026-04-24 after a production audit confirmed zero rows in pool/BYO. The enforcement work proposed here became unnecessary because the surface it was meant to guard no longer exists.

</details>
