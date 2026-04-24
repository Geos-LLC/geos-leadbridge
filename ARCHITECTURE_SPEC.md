# LeadBridge Architecture Spec (Definitive)

## Core Entities

```
User (1 login)
  └── SavedAccount (many platform businesses: Thumbtack, Yelp, Angi, Bark)
        ├── NotificationSettings (1)
        ├── CallConnectSettings (1)
        ├── AutomationRules (many)
        ├── NotificationRules (many)
        └── Leads (many, via businessId)
```

## Rules

### Users & Businesses
- One LeadBridge user can have multiple platform businesses (SavedAccounts).
- **Users are strictly isolated** from each other — no cross-user data leaks.
- **Businesses are isolated** in: leads, templates, automation rules, notification rules.
- **Businesses share** across the same user: business phone, dedicated number (usually).

### Phone Numbers (dedicated-only since 2026-04-24)

Every tenant has exactly **two** phone numbers. They serve different purposes and are not interchangeable. See `PHONE_NUMBER_SPEC.md` for full detail.

| Role | Source of truth | Purpose |
|---|---|---|
| **Business phone** (internal destination) | `User.businessPhone` | Receives alerts, target of call-connect bridge, optional SMS-forwarding target. Never shown to customers. |
| **Dedicated number** (customer-facing) | `TenantPhoneNumber` (status=`ACTIVE`) | Outbound SMS to customers; inbound SMS/calls from customers. Resolved at send time via `resolveBotPhone(userId, savedAccountId)`. |

Key behaviors:
- `resolveBotPhone` fallback chain: account-scoped → unassigned → any active → null.
- Always uses the tenant's Sigcore API key (`NotificationSettings.sigcoreApiKey`). The platform `SIGCORE_API_KEY` is only for platform-level operations (tenant provisioning, admin health checks).
- Inbound SMS routes through the per-account `NotificationSettings.inboundSmsWebhookId` subscription. Call-connect events route through `CallConnectSettings.sigcoreWebhookId` (distinct column, distinct table, distinct purpose).

### Business-phone consistency
`User.businessPhone` is the source of truth. The following are mirrored at save time via `syncBusinessPhoneToAccounts`:
- `NotificationSettings.destinationPhone`
- `CallConnectSettings.agentPhoneE164`
- `NotificationRule.toPhone` (per-rule override; defaults to settings.destinationPhone)

Single edit point: Settings → "Business Phone". Normalized to E.164 on save.

### Dashboard & Filtering
- Dashboard shows ALL businesses combined by default.
- User can filter to a single business via account selector.
- When filtered: Dashboard stats, Lead Activity, Analytics all scope to that `businessId`.
- When "All": aggregate across all businesses.

### Inbound SMS (customer → dedicated number)
- Sigcore delivers to `POST /webhooks/sigcore/inbound-sms?accountId=…`.
- LeadBridge matches to the correct business/lead using `toNumber` + `accountId` + stored conversation history.
- Message persisted to `Message` table (deduped by `platform` + `externalMessageId`).
- Optionally forwarded to `NotificationSettings.smsForwardingNumber` (typically = business phone).
- If no matching lead: still forward to business phone, but not shown in Lead Activity.

### Inbound Calls (customer → dedicated number)
- Sigcore delivers `call_connect.*` events to `POST /webhooks/sigcore/call-connect?accountId=…` with per-business HMAC signature.
- Call-connect rings `CallConnectSettings.agentPhoneE164` (= business phone).
- Bridges once agent accepts; voicemail-drop on fail if enabled.
- Per-business scripts/whispers/voicemail from `CallConnectSettings`.

### Tenant texts dedicated number
- Current behavior: send guidance message ("this is your LeadBridge number, customers text *this*").

### New Lead Flow
Depends on what's enabled for the business:
1. **Lead Notification** (notification rule enabled): SMS alert sent to business phone.
2. **Customer Communication** (automation rule enabled): Auto-reply to customer via platform API (Thumbtack/Yelp) or via dedicated SMS.
3. **Customer Texting** (if enabled): Customer texts the dedicated number; optionally forwarded to business phone.
4. **Call Connect** (if enabled): Calls between agent and customer bridged via dedicated number.

### Admin / Impersonation
- Admin can view AND edit settings for any user.
- Admin dashboard shows accounts with business names listed.
- When impersonating: admin sees exactly what the user sees, can modify settings.
- All changes are logged to `admin_logs`.
- Admin can reassign a `TenantPhoneNumber` to a different user via `PATCH /v1/admin/phone-pool/tenant/:id/reassign` (URL namespace is legacy; functionality is dedicated-only).

## What was removed (2026-04-24 — PRs #104, #105, #106)

- **Pool numbers** (`PhonePool`, `PhonePoolAssignment` tables, `admin-phone-pool.service.ts` routing logic, admin pool UI). Production had 0 rows.
- **BYO/OpenPhone routing** (`NotificationSettings.sigcoreFromPhone`, `sigcoreProvider`, `sigcoreWebhookId` columns; `connectSigcore`/`disconnectSigcore` endpoints; `connectProviderViaSigcore`, `disconnectProviderViaSigcore`, `fetchOpenPhoneNumbers` helpers; OpenPhone setup modal on Services page). Production had 0 OpenPhone tenants.
- **`senderMode` semantics** (`shared` / `dedicated` / `openphone`): column still exists but is effectively always `dedicated` now. Safe to drop in a follow-up.

## What was explicitly preserved

- `User.businessPhone` + `destinationPhone` + `agentPhoneE164` + `smsForwardingNumber` + `callForwardingNumber` — business-phone alert/forwarding chain.
- `NotificationSettings.inboundSmsWebhookId` — inbound SMS subscription.
- `CallConnectSettings.sigcoreWebhookId` + `sigcoreWebhookSecret` — call-connect event subscription (different table from the dropped `NotificationSettings.sigcoreWebhookId`).
- Twilio transport (via Sigcore) for dedicated-number delivery.
- `conversationSyncApi` OpenPhone integration — **read-only analytics** pulling historical conversations for AI context. Not a routing path.

## Outstanding cleanups (optional, not urgent)

- Rename `/v1/admin/phone-pool/*` URL namespace → something like `/v1/admin/phone/*` (no pool remains; name is misleading).
- Drop `NotificationSettings.senderMode` column (always `dedicated` now).
- Sigcore repo: remove `/integrations/openphone/*` endpoints (no one calls them).
