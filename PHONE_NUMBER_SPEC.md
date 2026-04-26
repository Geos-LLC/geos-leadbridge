# LeadBridge Phone Number Specification

> Reference for phone number roles, permitted uses, and implementation.
> Rewritten 2026-04-24 to reflect the dedicated-only model (pool and BYO/OpenPhone routing removed — see PRs #104, #105, #106).

---

## Overview: Two Phone Number Roles

LeadBridge uses exactly **two** phone numbers per tenant. They serve completely different purposes and should never be conflated.

| | Business Phone | LeadBridge Dedicated Number |
|---|---|---|
| **Role** | Internal destination | Customer-facing |
| **Who owns it** | The tenant (their personal or office phone) | LeadBridge (provisioned via Sigcore → Twilio) |
| **Customer ever texts/calls it?** | ❌ No — kept private | ✅ Yes — this is the number shown on Thumbtack/Yelp etc. |
| **Receives lead alerts** | ✅ Yes | ❌ No |
| **Receives forwarded customer calls/SMS** | ✅ Yes (via call-connect / SMS forwarding) | — |
| **Sends outbound SMS to customers** | ❌ | ✅ Yes |
| **Places/receives customer calls** | ❌ | ✅ Yes (bridged to business phone via call-connect) |
| **DB / code** | `User.businessPhone`, `NotificationSettings.destinationPhone`, `CallConnectSettings.agentPhoneE164` | `TenantPhoneNumber` (status=`ACTIVE`) |

---

## 1. Business Phone (internal destination)

**DB:** `User.businessPhone` is the single source of truth. `NotificationSettings.destinationPhone`, `CallConnectSettings.agentPhoneE164`, and `NotificationRule.toPhone` are mirror/override fields kept in sync.

### Permitted uses
- Receives **new-lead SMS alerts** ("new Thumbtack lead from Jane — call 555-1234").
- Receives **forwarded customer calls** when a customer calls the LeadBridge dedicated number (call-connect bridges the call to business phone).
- Receives **forwarded customer SMS** (optional, via `NotificationSettings.smsForwardingNumber` = business phone).

### Key rules
- Never shown to customers. Stays private.
- Set once in Settings → "Business Phone"; `syncBusinessPhoneToAccounts` propagates to downstream fields.
- Normalized to E.164 on save.

---

## 2. LeadBridge Dedicated Number (customer-facing)

**DB:** `TenantPhoneNumber` with `status='ACTIVE'`. Resolved by `resolveBotPhone(userId, savedAccountId)` in `notifications.service.ts`.
**Provider:** Twilio number allocated to the tenant's Sigcore workspace.
**API key:** Tenant's own Sigcore API key (`NotificationSettings.sigcoreApiKey`). **Never** use the platform `SIGCORE_API_KEY` for tenant operations.

### resolveBotPhone fallback chain
1. Account-scoped `TenantPhoneNumber` (`userId` + `savedAccountId` match, status ACTIVE)
2. Unassigned tenant number (`userId` match, `savedAccountId=null`, status ACTIVE)
3. Any active tenant number for the user
4. `null` → send path returns `No dedicated number for account` error

### Permitted uses
- **Outbound customer SMS** — lead replies, follow-ups, auto-replies. `sendNotificationWithRule` (rule-triggered) and `sendAdHocSms` (manual/UI) both resolve fromPhone this way.
- **Inbound customer SMS** — received via Sigcore `POST /webhooks/sigcore/inbound-sms` (registered per account via `ensureInboundSmsWebhook` → `NotificationSettings.inboundSmsWebhookId`). Persisted to `Message` table; optionally forwarded to business phone via `smsForwardingNumber`.
- **Call-connect** — customer calls the dedicated number → Sigcore fires `call_connect.*` webhook → LeadBridge rings the business phone → bridges once agent accepts.

### Assignment paths
- **Self-purchase**: `POST /v1/notifications/tenant-phones/purchase` — Sigcore allocates a Twilio number, creates `TenantPhoneNumber` row. Gated to plans that allow it (see `plan-gates` logic).
- **Admin reassign**: `PATCH /v1/admin/phone-pool/tenant/:id/reassign` — admin moves an existing number between users. Triggers Sigcore `reallocate` + `refresh-webhooks` so Twilio routes the new tenant's webhooks correctly.

### Key rules
- Strictly per-tenant: `TenantPhoneNumber.userId` enforces ownership; cross-tenant use is prohibited.
- `CallConnectSettings.sigcoreWebhookId` (distinct from the deleted `NotificationSettings.sigcoreWebhookId`) stores the per-account call-connect event subscription.

---

## Routing flow

```
Outbound customer SMS (rule or ad-hoc)
  sendNotificationWithRule / sendAdHocSms
    → resolveBotPhone(userId, savedAccountId)  [TenantPhoneNumber lookup]
    → Sigcore POST /v1/messages  [tenant API key]
    → Twilio send

Outbound alert to business phone (new-lead notification)
  sendNotificationWithRule (sendToCustomer=false)
    → from: resolveBotPhone (dedicated number)
    → to:   rule.toPhone || settings.destinationPhone  [business phone]
    → Sigcore POST /v1/messages

Inbound customer SMS
  Sigcore delivers to /webhooks/sigcore/inbound-sms?accountId=…
    → persist Message, upsert Conversation
    → optional forward to NotificationSettings.smsForwardingNumber (business phone)

Inbound customer call
  Sigcore delivers call_connect.* events to /webhooks/sigcore/call-connect?accountId=…
    → ring CallConnectSettings.agentPhoneE164 (business phone)
    → bridge once agent accepts, or voicemail-drop on fail
```

---

## What no longer exists (removed 2026-04-24)

- **Pool numbers** (`PhonePool`, `PhonePoolAssignment` tables, `admin-phone-pool.service.ts`) — production had 0 rows. Not a concept anymore.
- **BYO / OpenPhone routing** (`NotificationSettings.sigcoreFromPhone`, `sigcoreProvider`, `sigcoreWebhookId` columns; `connectSigcore` endpoint; OpenPhone setup modal) — production had 0 OpenPhone tenants.
- **Platform-key vs tenant-key branching** — always tenant key now. `sendAdHocSms` / `sendNotificationWithRule` simplified accordingly.

If the AI conversation-sync feature (`conversationSyncApi.connect`) ever surfaces OpenPhone again, that's a **read-only analytics integration** (pulling historical conversations for ML), not a routing path.
