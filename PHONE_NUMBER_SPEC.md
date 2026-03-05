# LeadBridge Phone Number Specification

> Reference document for phone number types, permitted uses, and implementation requirements.
> Created: 2026-03-04

---

## Overview: Three Phone Number Types

| | Pool Number | BYO (OpenPhone) | Dedicated Number |
|---|---|---|---|
| **Scope** | Shared – all tenants | Per-tenant only | Per-tenant only |
| **Source** | Admin provisions via Twilio | Tenant connects their OpenPhone account | Tenant buys via Sigcore API, or Admin assigns |
| **Tenant alerts** | ✅ Yes | ✅ Yes — only if alert destination ≠ BYO number | ✅ Yes |
| **Customer SMS** | ❌ No | ✅ Yes | ✅ Yes (with forwarding) |
| **Instant calls / Call Connect** | ❌ No | ❌ No | ✅ Yes (with forwarding) |
| **Cross-tenant use** | ✅ All tenants share | ❌ Strictly isolated | ❌ Strictly isolated |

---

## 1. Pool Numbers

**DB:** `PhonePool` + `PhonePoolAssignment`
**Provider:** Platform's Twilio account (platform API key)
**sigcoreProvider:** `null` / uses platform Sigcore workspace key

### Permitted uses
- **Tenant alerts only** — notification rules where the recipient is the tenant (pro), not the customer.

### NOT permitted
- Customer-facing SMS (`sendToCustomer = true`)
- Call Connect / instant calls
- SMS/call forwarding target

### Key rules
- Any non-released pool phone can be used by any tenant (shared resource).
- The **platform API key** (env `SIGCORE_API_KEY`) must always be used when sending from a pool number — never the tenant's own key.
- Assignment via `PhonePoolAssignment` is informational; it doesn't restrict other tenants from using the same number.

---

## 2. BYO Number (OpenPhone)

**DB:** `NotificationSettings.sigcoreFromPhone` + `sigcoreProvider='openphone'`
**Provider:** Tenant's own OpenPhone account, brokered through Sigcore
**sigcoreProvider:** `'openphone'`
**API key:** Tenant's own Sigcore API key (from `NotificationSettings.sigcoreApiKey`)

### Permitted uses
- **Customer SMS** — outbound text messages to leads/customers.
- **Tenant alerts** — outbound alerts to the tenant's destination phone, **only if the destination phone is different from the BYO number itself**. Sending from OpenPhone back to the same OpenPhone number would loop the message and is blocked.

### NOT permitted
- Tenant alerts where `toPhone === fromPhone` (same number — blocked by guard in `sendNotificationWithRule`)
- Call Connect / voice calls (OpenPhone numbers cannot be used for outbound PSTN calls through Sigcore)
- SMS forwarding origination (inbound pool-phone SMS should NOT be forwarded from an OpenPhone number to avoid number confusion)

### Key rules
- Strictly per-tenant: `sigcoreFromPhone` is validated against `savedAccount.userId` in `validatePhoneOwnership()`.
- Tenant's Sigcore API key is used — never the platform key.
- `tenant_phone_numbers` in Sigcore must be populated via `POST /integrations/openphone/connect` before messages can route correctly. If it breaks, user must reconnect OpenPhone in Notification Settings.

---

## 3. Dedicated Number

**DB:** `TenantPhoneNumber` (status=`ACTIVE`)
**Provider:** Twilio, brokered through tenant's Sigcore tenant
**sigcoreProvider:** `'twilio'` (dedicated per-tenant Twilio number)
**API key:** Tenant's own Sigcore API key

### Permitted uses
- **Tenant alerts** — notification rules where the tenant is the recipient.
- **Customer SMS** — outbound texts to leads/customers (with or without forwarding).
- **Instant calls / Call Connect** — tenant's dedicated Twilio number can receive inbound calls and forward/bridge them.
- **SMS forwarding** — inbound SMS received on the dedicated number can be forwarded to any configured target (e.g. the tenant's personal phone or BYO number).
- **Call forwarding** — inbound calls can be forwarded to the tenant's personal phone or BYO number.

### Assignment paths
1. **Self-purchase**: Tenant buys via Sigcore API (`POST /notifications/purchase-phone-number`) — provisions Twilio number through Sigcore, creates `TenantPhoneNumber` record.
2. **Admin assignment**: Admin converts a pool phone to dedicated (`POST /admin/phone-pool/:id/convert-to-tenant`) or directly assigns via the admin panel.

### Key rules
- Strictly per-tenant: `TenantPhoneNumber.userId` must match the requesting user.
- Cross-tenant assignment is prohibited — admin assignment must update `userId` on the record.
- **Forwarding** (SMS and voice) is the mechanism that makes customer-facing use practical: since the dedicated number is a Twilio number, calls/texts it receives can be forwarded to the tenant's BYO number (OpenPhone) or any personal number.
- Tenant's Sigcore API key is used — never the platform key.

---

## Forwarding Patterns for Dedicated Numbers

```
Inbound Customer SMS  →  Dedicated Number  →  forward to BYO (OpenPhone) or personal phone
Inbound Customer Call →  Dedicated Number  →  forward to BYO or personal phone (Call Connect / instant bridge)
Outbound Alert SMS    →  Dedicated Number  →  direct send (no forwarding needed)
Outbound Customer SMS →  Dedicated Number  →  direct send via Sigcore/Twilio
```

---

## Implementation Guards Required

### Current state vs spec (gaps as of 2026-03-04)

| Guard | Required | Status |
|-------|----------|--------|
| Pool numbers blocked from customer SMS | ✅ Required | ❌ Not enforced — pool falls back into `sendAdHocSms` |
| BYO alert blocked when `toPhone === fromPhone` | ✅ Required | ✅ Implemented in `sendNotificationWithRule` (2026-03-04) |
| Cross-tenant phone validation | ✅ Required | ✅ Partial — `validatePhoneOwnership()` exists but pool always returns true |
| Pool sends use platform key | ✅ Required | ✅ Implemented in `sendNotificationWithRule` + `sendAdHocSms` |
| Dedicated sends use tenant key | ✅ Required | ✅ Implemented |
| OpenPhone sends use tenant key | ✅ Required | ✅ Implemented |
| Call forwarding restricted to dedicated | ✅ Required | ❌ Not enforced |
| Forwarding target validation | ✅ Required | ❌ `callForwardingNumber` / `smsForwardingNumber` not validated |

### Guards to implement

1. **`sendNotificationWithRule()`** — if `rule.sendToCustomer = false` (alert), block `sigcoreProvider='openphone'`; require pool or dedicated.
2. **`sendAdHocSms()`** — block pool phones (use only dedicated or OpenPhone for customer SMS).
3. **Rule creation/update** — if `sendToCustomer = true`, validate fromPhone is dedicated or OpenPhone (not pool).
4. **`validatePhoneOwnership()`** — return phone type alongside ownership so callers can enforce type rules.
5. **`callForwardingNumber` / `smsForwardingNumber` set** — validate format; for `smsForwardingNumber` validate E.164.
6. **Call Connect** — require dedicated number (`TenantPhoneNumber` active) before enabling.

---

## Routing Quick Reference

```
senderMode='shared'     → pool number   → platform Sigcore key → platform Twilio
senderMode='openphone'  → BYO number    → tenant Sigcore key   → OpenPhone
senderMode='dedicated'  → TenantPhone   → tenant Sigcore key   → dedicated Twilio
```

When `fromPhone` resolves to a `PhonePool` entry → always switch to platform key (regardless of `senderMode`).
When `fromPhone` resolves to a `TenantPhoneNumber` or `sigcoreFromPhone` with `sigcoreProvider='openphone'` → use tenant key.
