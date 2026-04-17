# TASK — LeadBridge CRM Integration API

## Goal

Add a generic outbound webhook system to LeadBridge so any external CRM (ServiceFlow, or future CRMs) can receive real-time events when leads, messages, and status changes happen.

LB already has the inbound REST API (read leads, messages, send). What's missing is **outbound event push** — LB doesn't forward events to external systems yet.

---

## What Exists

### REST API (already built, CRMs can call these):
- `POST /api/auth/login` → JWT token
- `GET /api/v1/platforms/saved-accounts` → list connected TT/Yelp accounts
- `GET /api/v1/thumbtack/leads` → list leads (works for both TT and Yelp)
- `GET /api/v1/thumbtack/leads/:id/messages` → messages (works for both platforms)
- `POST /api/v1/thumbtack/leads/:id/message` → send message (works for both platforms)

### Webhook receiving (already built, LB receives FROM platforms):
- `POST /api/webhooks/thumbtack` — receives TT events
- `POST /api/webhooks/yelp` — receives Yelp events
- Events processed in `webhooks.service.ts`

### What's missing:
- **No outbound webhook push** to external CRMs
- When a new lead arrives or a message is received, LB processes it internally but doesn't notify any external system

---

## Required Changes

### 1. New table: `crm_webhook_subscriptions`

```
id          String   @id @default(uuid())
userId      String
name        String   // "Service Flow CRM", "Custom CRM"
webhookUrl  String   // https://sf-backend.railway.app/api/integrations/leadbridge/webhooks
secret      String?  // HMAC secret for signature verification
events      String[] // ["lead.created", "message.received", "message.sent", "lead.status_changed"]
isActive    Boolean  @default(true)
metadata    Json?
createdAt   DateTime @default(now())
updatedAt   DateTime @updatedAt

@@unique([userId, webhookUrl])
```

### 2. New endpoints

```
POST   /api/v1/integrations/webhooks          — register webhook subscription
GET    /api/v1/integrations/webhooks          — list subscriptions
DELETE /api/v1/integrations/webhooks/:id      — remove subscription
POST   /api/v1/integrations/webhooks/:id/test — send test event
```

### 3. Webhook forwarding service

New service: `CrmWebhookService`

Methods:
- `emit(userId, eventType, payload)` — sends to all active subscriptions for that user
- `sendWebhook(subscription, payload)` — HTTP POST with HMAC signature
- Retry logic: 1 retry on failure, log errors

### 4. Normalized event payload

```json
{
  "event_id": "evt_uuid",
  "event_type": "lead.created",
  "occurred_at": "2026-04-08T15:00:00Z",
  "provider": "leadbridge",
  "channel": "thumbtack",
  "account_id": "saved_account_uuid",
  "thread": {
    "external_conversation_id": "conversation_uuid",
    "external_lead_id": "lead_uuid",
    "external_location_id": "business_id_from_platform"
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

### 5. Event types to support

| Event | When | Payload includes |
|---|---|---|
| `lead.created` | New TT/Yelp lead arrives | lead + first message + participant |
| `message.received` | Customer sends a message | message + thread + participant |
| `message.sent` | Agent/automation sends a message | message + thread |
| `lead.status_changed` | Lead status updated (hired, not hired) | lead + old/new status |

### 6. Integration points in existing code

Add `crmWebhookService.emit()` calls at these points in `webhooks.service.ts`:

1. **After line 348** (`this.eventEmitter.emit('lead.created...')`):
   ```
   this.crmWebhookService.emit(userId, 'lead.created', { lead, message, participant, account })
   ```

2. **After message processing** (customer reply handling ~line 700-800):
   ```
   this.crmWebhookService.emit(userId, 'message.received', { message, thread, participant })
   ```

3. **After outbound message sent** (in leads.service.ts sendMessage):
   ```
   this.crmWebhookService.emit(userId, 'message.sent', { message, thread })
   ```

4. **After Yelp lead processing** (~line 1586):
   ```
   this.crmWebhookService.emit(userId, 'lead.created', { lead, message, participant, account })
   ```

### 7. SF connect flow update

When SF connects to LB (`POST /api/integrations/leadbridge/connect` on SF side), after getting the JWT token, SF should also register a webhook subscription:

```
POST LB_URL/api/v1/integrations/webhooks
{
  "name": "Service Flow CRM",
  "webhookUrl": "https://service-flow-backend-staging-303f.up.railway.app/api/integrations/leadbridge/webhooks",
  "events": ["lead.created", "message.received", "message.sent", "lead.status_changed"],
  "secret": "generated_hmac_secret"
}
```

SF's `leadbridge-service.js` connect handler should do this after successful login.

---

## Security

- HMAC-SHA256 signature in `X-LB-Signature` header
- Secret stored per subscription
- SF verifies signature before processing

---

## Acceptance Criteria

1. When a new TT/Yelp lead arrives, LB pushes event to registered CRM webhooks
2. When a customer sends a message, LB pushes event
3. When an agent sends a message, LB pushes event
4. SF receives events and creates/updates conversations + leads in real-time
5. No manual sync needed for new leads
6. Webhook registration via API (not hardcoded)
7. Multiple CRMs can subscribe independently

---

## Files to modify

### LeadBridge:
- `prisma/schema.prisma` — add CrmWebhookSubscription model
- New: `src/integrations/crm-webhook.service.ts` — forwarding logic
- New: `src/integrations/integrations.controller.ts` — webhook CRUD endpoints (or extend existing)
- `src/webhooks/webhooks.service.ts` — add emit() calls at event points
- `src/leads/leads.service.ts` — add emit() on message send

### ServiceFlow (after LB is done):
- `leadbridge-service.js` — register webhook during connect flow
- Verify HMAC signature in webhook handler
