HIGH-LEVEL GOAL

When a new lead is created in LeadBridge:

LeadBridge automatically replies to the lead (already implemented)

LeadBridge sends a notification SMS to the company’s phone number with lead details

This must work per tenant, with configurable sender options:

shared Callio number

dedicated Callio number per tenant

customer’s OpenPhone number (via API key)

PART 1 — WHAT TO DEVELOP IN CALLIO
1. Callio as the Communications Authority

Callio is responsible for:

Provider integrations (Twilio, OpenPhone, WhatsApp)

Phone number inventory and assignment

Conversation/contact lifecycle

Message delivery and provider webhooks

Compliance (STOP, HELP, opt-out handling)

Delivery status tracking

LeadBridge only sends intent (“send this message to this phone”).

2. REQUIRED NEW CALLIO API ENDPOINTS (CORE)
A. Unified send endpoint (CRITICAL)

Add a single endpoint so LeadBridge does not need to manage contacts or conversations.

POST /api/v1/messages/send


Request

{
  "to": "+15551234567",
  "body": "New lead: John Smith\nPhone: +15559876543\nService: Deep Cleaning\nLocation: Tampa, FL",
  "sender": {
    "mode": "shared | dedicated | openphone",
    "fromNumber": "+15550001111" 
  },
  "metadata": {
    "tenantId": "leadbridge_tenant_123",
    "leadId": "lead_987"
  }
}


Callio internal behavior

Normalize phone numbers (E.164)

Find or create contact

Find or create conversation

Select provider (Twilio/OpenPhone/WhatsApp)

Select sender number

Send message

Store provider message ID

Return delivery status

Response

{
  "success": true,
  "data": {
    "conversationId": "conv_123",
    "messageId": "msg_456",
    "provider": "twilio",
    "status": "queued"
  }
}

B. Phone number management (for UI + provisioning)

Extend /phone-numbers to support:

GET /phone-numbers?mode=shared|dedicated&assigned=true
POST /phone-numbers/provision
POST /phone-numbers/assign
POST /phone-numbers/release


Provision request

{
  "country": "US",
  "areaCode": "813",
  "workspaceId": "callio_ws_123"
}

C. Integration management (OpenPhone)
POST /integrations/openphone/connect
GET  /integrations/openphone/numbers
DELETE /integrations/openphone/disconnect


Connect request

{
  "apiKey": "OPENPHONE_API_KEY"
}


Callio stores provider credentials securely per workspace.

D. Webhooks (for LeadBridge)

Callio must emit webhooks:

message.delivered

message.failed

message.inbound (future use)

Webhook payload includes:

{
  "event": "message.delivered",
  "messageId": "msg_456",
  "tenantId": "leadbridge_tenant_123",
  "leadId": "lead_987",
  "timestamp": "ISO_DATE"
}

3. CALLIO DATA MODEL (MINIMUM)

workspaces

id

name

owner

providerConnections (twilio, openphone, whatsapp)

phone_numbers

id

number

provider

mode (shared / dedicated)

assignedWorkspaceId

messages

id

conversationId

provider

from

to

body

providerMessageId

status

metadata (tenantId, leadId)

PART 2 — WHAT TO DEVELOP IN LEADBRIDGE
1. LeadBridge Responsibilities

LeadBridge is responsible for:

Tenant accounts

Lead ingestion (Thumbtack/Yelp/etc.)

Message templates

Notification rules

UI configuration

Billing tiers

Logging and analytics

LeadBridge never manages phone numbers directly.

2. LeadBridge UI (WHAT USERS SEE)
A. Notification Settings Page

Section 1 — Enable notifications

Toggle: “Send SMS notification when a new lead arrives”

Field: “Send to phone number” (company phone)

Section 2 — Sender mode

Radio buttons:

Shared number (default, fast setup)

Dedicated number (paid)

Use my OpenPhone number (paid)

Section 3 — Message template

Text editor with variables:

{{lead.name}}

{{lead.phone}}

{{lead.service}}

{{lead.location}}

{{lead.link}}

Section 4 — Rules

Quiet hours

Send only if lead has phone

Multiple recipients

Section 5 — Test

“Send test SMS” button

B. Notification Log UI

Table:

Time

Lead

To

From

Provider

Status

Error (if any)

3. LeadBridge Backend API
Tenant settings
GET  /tenants/:id/notification-settings
PUT  /tenants/:id/notification-settings
POST /tenants/:id/notification-settings/test

Lead event handling (internal)

On LeadCreated:

Auto-reply engine (existing)

Push SendNotificationJob to queue

4. LeadBridge → Callio Interaction

Worker flow

LeadCreated
 → Load tenant notification settings
 → Render message template
 → POST /callio/messages/send
 → Save result in notification_logs


On webhook

Update message status

Show in UI

5. LeadBridge Data Model (MINIMUM)

tenant_notification_settings

tenantId

enabled

destinationPhone

senderMode (shared | dedicated | openphone)

callioWorkspaceId

template

quietHours

createdAt

notification_logs

id

tenantId

leadId

to

from

provider

status

error

timestamps

PRODUCT & PRICING ALIGNMENT (IMPORTANT)

Basic tier → shared Callio number

Pro tier → dedicated Callio number

Premium tier → OpenPhone integration

This allows:

immediate MVP

clean upsells

future two-way messaging & AI follow-ups

FINAL INSTRUCTION TO CLAUDE

Using the above specification:

Design missing Callio endpoints and internal logic

Design LeadBridge backend services and queue workers

Suggest DB schemas (Postgres)

Suggest API contracts and error handling

Keep both systems loosely coupled and scalable