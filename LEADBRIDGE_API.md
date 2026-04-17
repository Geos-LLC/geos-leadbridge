Use this for the AI agent.

---

# TASK — LeadBridge Real-Time CRM Webhook API

## Production-ready, aligned with Sigcore + ServiceFlow architecture

## Goal

Add a **generic outbound webhook system** to LeadBridge so external CRMs can receive **real-time events** when leads, messages, and lead status changes happen.

This is required because LeadBridge currently has:

* inbound platform webhooks from Thumbtack/Yelp,
* read/send REST APIs,
* but **no outbound live event push to ServiceFlow**. 

This task must be implemented in a way that fits the broader architecture:

* **Sigcore is the source of truth for business identity and shared communication assets**
* **ServiceFlow is already integrated with Sigcore**
* **LeadBridge is not yet properly registered through the Sigcore business identity model**
* this webhook system should support the current direct LB → SF real-time bridge **without blocking** the later LB → Sigcore → SF architecture. 

---

# Architectural intent

## What this task is

This task adds:

* outbound CRM webhook subscriptions in LeadBridge
* normalized real-time event delivery
* automatic webhook registration from ServiceFlow during LB connect
* payloads that include enough identity context for ServiceFlow to ingest correctly

## What this task is not

This task does **not** replace the cross-app identity roadmap.

It is a **bridge step**:

* **now:** LB emits directly to SF webhook endpoint
* **later:** LB should also integrate fully with Sigcore business identity and asset registration

So implement this in a way that is:

* useful immediately
* not coupled to old user-only assumptions
* compatible with future Sigcore-based routing. "C:\Users\HP\Desktop\Projects\Active\Development\service-flow\plans\2026-04-07-cross-app-identity-status-and-next-steps.md"

---

# Existing architecture context

## Current relevant state

* ServiceFlow already built Phase A LeadBridge communication ingestion with:

  * `communication_provider_accounts`
  * `communication_participant_identities`
  * location-aware mapping via `territories`
  * webhook + sync ingestion
  * generic send endpoint. 
* Multi-location communication in SF is done through territories, not `sf_locations`.
* Sigcore already provides:

  * `businesses`
  * `product_workspaces`
  * `shared_communication_assets`
  * `workspace_asset_links`
  * identity resolution + routing services. 
* LeadBridge is still incomplete in that model:

  * not registered as `product_workspace`
  * no shared assets for assigned numbers
  * still partly transitional with Sigcore IDs. 

---

# Core requirements

## 1) Add outbound CRM webhook subscriptions to LeadBridge

### New table

Add a subscription table for outbound CRM webhooks.

Suggested model name:

* `CrmWebhookSubscription`

Suggested fields:

* `id`
* `userId` or tenant owner FK already used in LB
* `name`
* `webhookUrl`
* `secret`
* `events` array
* `isActive`
* `metadata`
* `createdAt`
* `updatedAt`

Suggested unique rule:

* unique `(userId, webhookUrl)`

### Important note

This table can remain LB-user scoped internally for now if that is how LB organizes integrations today.

However:

* outbound **event payloads must not rely only on `userId`**
* event payloads must include workspace/business identity fields when available

So: subscription storage may be user-scoped, but emitted identity must be workspace/business aware.

---

## 2) Add webhook subscription management endpoints

Create endpoints like:

* `POST /api/v1/integrations/webhooks`
* `GET /api/v1/integrations/webhooks`
* `DELETE /api/v1/integrations/webhooks/:id`
* `POST /api/v1/integrations/webhooks/:id/test`

These are used by ServiceFlow during connect and for operational debugging.

### Expected behavior

* create subscription
* list active subscriptions
* delete/deactivate subscription
* send test event with normalized payload + signature

---

## 3) Add outbound webhook delivery service

Create a service such as:

* `CrmWebhookService`

Methods:

* `emit(...)`
* `sendWebhook(...)`
* `buildPayload(...)`
* optional retry helper

### Required behavior

* send to all active subscriptions matching the owner/integration context
* HMAC-SHA256 signature
* 1 retry on failure minimum
* structured logging of failures
* do not throw in a way that breaks platform webhook processing

### Important rule

Outbound CRM webhook failures must not break LB’s core platform webhook ingestion.

---

# Critical architecture corrections

## 4) Do NOT design emitted events around `userId` only

The current draft task uses:

* `emit(userId, eventType, payload)`

That is not sufficient for your full architecture.

### Required change

The emitted payload must include:

* LB-local owner/user context if needed internally
* **Sigcore business/workspace context if available**
* provider account context
* structured asset/contact context

Suggested internal emit signature can still be something like:

* `emit(ownerId, eventType, payloadContext)`

But the final normalized event body must carry business/workspace identity fields.

---

## 5) Include Sigcore identity fields in payload when available

LeadBridge already has transitional fields like:

* `sigcoreWorkspaceId`
* `sigcoreBusinessId` on user-related records. 

### Required payload additions

Include:

* `sigcore_workspace_id`
* `sigcore_business_id`

If unavailable, send `null`, but include the fields in the schema.

### Reason

This keeps the real-time bridge compatible with the long-term identity model and helps SF route/process events correctly.

---

## 6) Include structured asset context, not just raw phone

Because the long-term routing model is based on shared communication assets, payloads must include structured asset info.

### Required payload addition

Add something like:

```json id="6gv0r8"
"asset": {
  "type": "phone",
  "value": "+13013292284",
  "normalized": "+13013292284",
  "role": "lead_capture"
}
```

If a phone is unavailable, set fields to null rather than omitting the object entirely.

### Reason

This supports future alignment with Sigcore shared assets and workspace routing. 

---

## 7) Include provider account and location context explicitly

Because SF is already location-aware and uses territories for Thumbtack/Yelp multi-location routing, outbound events must include:

* provider account ID
* external business/location fields
* location display info if known

### Required payload fields

Include:

* `account_id`
* `external_account_id` if distinct
* `external_business_id`
* `external_location_id`
* `external_location_name`

This is especially important for Yelp multi-location behavior and the current SF territory mapping model. 

---

# Normalized event contract

## 8) Use a stable normalized payload schema

All webhook event types must use the same envelope.

### Required envelope

```json
{
  "event_id": "evt_uuid",
  "event_type": "lead.created",
  "occurred_at": "2026-04-08T15:00:00Z",

  "provider": "leadbridge",
  "channel": "thumbtack",

  "sigcore_workspace_id": "sc_ws_123",
  "sigcore_business_id": "sc_biz_456",

  "account_id": "saved_account_uuid",
  "external_account_id": "platform_account_id_if_any",
  "external_business_id": "biz_456",
  "external_location_id": "loc_123",
  "external_location_name": "Jacksonville",

  "asset": {
    "type": "phone",
    "value": "+13013292284",
    "normalized": "+13013292284",
    "role": "lead_capture"
  },

  "thread": {
    "external_conversation_id": "conversation_uuid",
    "external_thread_id": "thread_uuid",
    "external_lead_id": "lead_uuid"
  },

  "participant": {
    "external_contact_id": "lead_uuid",
    "name": "Angela Candela",
    "phone": "+13013292284",
    "email": null
  },

  "message": {
    "external_message_id": "msg_uuid",
    "direction": "inbound",
    "body": "Hi, I need a house cleaning quote",
    "sent_at": "2026-04-08T14:59:00Z"
  },

  "lead": {
    "id": "lead_uuid",
    "status": "new",
    "category": "House Cleaning",
    "budget": 189,
    "city": "Tampa",
    "state": "FL"
  },

  "raw": {}
}
```

### Notes

* Keep fields present even if some values are null
* `raw` may contain provider-specific original payload fragments
* this schema should be stable across TT and Yelp

---

## 9) Event types to support

Support at minimum:

* `lead.created`
* `message.received`
* `message.sent`
* `lead.status_changed`

These match the current draft and are correct for SF real-time ingestion. TASK_CRM_INTEGRATION_API

---

# Integration points in LB code

## 10) Emit normalized CRM webhooks at existing event points

Add `crmWebhookService.emit(...)` calls in the relevant existing LB flows:

### A. New lead arrival

After internal lead creation/processing for both:

* Thumbtack lead creation
* Yelp lead creation

Emit:

* `lead.created`

### B. Customer inbound message

After processing inbound message from platform webhook

Emit:

* `message.received`

### C. Outbound message sent

After successful outbound send in LB send-message flow

Emit:

* `message.sent`

### D. Lead status changes

After hired/not hired/archive/other meaningful status transitions

Emit:

* `lead.status_changed`

### Important implementation rule

Build the normalized payload in **one shared helper** so event shape stays consistent across all emit points.

---

# Security and delivery rules

## 11) HMAC signing

Send:

* `X-LB-Signature`
* optionally `X-LB-Timestamp`

Signature:

* HMAC-SHA256 over timestamp + request body, or body only if simpler
* use subscription secret

### Required behavior on SF side

SF will verify the signature before processing.

---

## 12) Delivery robustness

Minimum requirements:

* 1 retry on failure
* log response status + body excerpt on failure
* mark test events separately if helpful
* do not retry forever in this task

Optional future improvement:

* delivery history table / dead-letter queue

---

# ServiceFlow connect flow update

## 13) When SF connects to LB, auto-register webhook subscription

During:

* `POST /api/integrations/leadbridge/connect` on SF side

After successful LB login / account fetch:

* register outbound webhook subscription in LB automatically

### Example

```json
{
  "name": "Service Flow CRM",
  "webhookUrl": "https://service-flow-backend-staging-303f.up.railway.app/api/integrations/leadbridge/webhooks",
  "events": ["lead.created", "message.received", "message.sent", "lead.status_changed"],
  "secret": "generated_hmac_secret"
}
```

### Important note

This is the **current bridge integration**.
Do not redesign SF connect flow yet around full Sigcore-only mediation in this task.

---

# Explicit compatibility with future Sigcore architecture

## 14) Implement with future Sigcore alignment in mind

This task must not block the next roadmap step:

* **LeadBridge → Sigcore registration**
* full asset/workspace linkage
* eventual stronger identity-driven routing. 

### Required implementation notes

* do not hardcode ServiceFlow-specific assumptions in LB
* do not make payload schema depend on SF table names
* include Sigcore fields when available
* keep provider account, location, and asset as separate concepts

---

# What this task does NOT include

Do not include in this task:

* Lead/customer creation logic inside SF
* full LB registration as `product_workspace` in Sigcore
* replacing all direct LB ↔ SF integration with Sigcore mediation
* SF core table migration from `user_id` to `workspace_id`
* cross-app identity resolution logic inside LB itself

Those are separate roadmap tasks. 

---

# Acceptance criteria

This task is complete only when:

1. LB can register, list, delete, and test outbound CRM webhook subscriptions
2. LB emits normalized outbound events for:

   * `lead.created`
   * `message.received`
   * `message.sent`
   * `lead.status_changed`
3. SF can register its webhook subscription automatically during LB connect
4. Payloads include:

   * Sigcore IDs when available
   * provider account context
   * raw location context
   * structured asset data
5. HMAC signature is included on outbound webhook delivery
6. Webhook send failures do not break LB platform webhook processing
7. Implementation is generic enough for future CRMs, not only SF
8. Design remains compatible with later LB → Sigcore registration work

---

# Files likely to modify

### LeadBridge

* `prisma/schema.prisma` — add `CrmWebhookSubscription`
* new `crm-webhook.service.ts`
* new or extended integrations controller for webhook subscription CRUD
* `webhooks.service.ts` — add emit calls
* `leads.service.ts` — add emit on outbound send
* any shared normalization helper for payload building

### ServiceFlow

* `leadbridge-service.js` — register webhook during connect flow
* webhook handler — verify HMAC signature if not already implemented for LB path

---

# Implementation notes for the agent

* Keep the outbound webhook API generic.
* Do not rename fields to ServiceFlow-specific names.
* Prefer stable normalized fields over copying raw platform objects.
* Treat this as the **real-time bridge layer** for the current architecture, not the final identity architecture.
* Add concise inline comments where identity-related fields are transitional or future-facing.

---

If you want, I can also turn this into a **short Cursor-style prompt** with less explanation and more direct implementation instructions.
