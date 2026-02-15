Here’s a **clean, ready-to-paste task for an AI coder** (Claude / Cursor / Copilot).
It’s written as an **execution checklist + acceptance criteria**, focused only on **what to add**, since you already have number propagation working.

---

# TASK: Automatically Attach Propagated Phone Numbers to A2P Campaign (Callio + LeadBridge)

## Context

We have a multi-tenant system with two services:

* **Callio** – communication proxy (Twilio, OpenPhone, WhatsApp)
* **LeadBridge** – lead automation platform

Phone number propagation (buying / assigning a Twilio number per tenant) is **already implemented** in both Callio and LeadBridge.

**Missing piece:**
When a new phone number is provisioned for a tenant, it must be **automatically attached to an existing approved A2P 10DLC Campaign** so it can be used to send SMS immediately.

We are using **one approved campaign** for the use case:

> “Internal lead alert notifications sent to business owners”

---

## Goal

When a tenant is created and a Twilio phone number is provisioned:

1. The phone number is automatically added to the **Twilio Messaging Service** associated with the approved A2P campaign
2. The number becomes **A2P-compliant and ready to send**
3. Callio exposes the readiness status to LeadBridge

LeadBridge should not interact with Twilio directly.

---

## PART 1 — Callio: What to Implement

### 1. Configuration (ENV / DB)

Add configuration values to Callio:

* `TWILIO_MESSAGING_SERVICE_SID_LEAD_ALERTS` (MGxxxxxxxx)
* (Optional) `A2P_CAMPAIGN_TYPE = "lead_alerts"`

These represent the **already approved campaign**.

---

### 2. Extend Phone Number Provisioning Flow

#### Existing flow (already implemented)

* Buy / allocate Twilio phone number
* Assign it to a tenant workspace
* Store:

  * E.164 phone number
  * Twilio `PhoneNumberSid` (PNxxxx)

#### NEW STEP TO ADD (MANDATORY)

After provisioning succeeds:

➡️ **Add the phone number to the Twilio Messaging Service sender pool**

Twilio API:

```
POST https://messaging.twilio.com/v1/Services/{MessagingServiceSid}/PhoneNumbers
```

Payload:

```
PhoneNumberSid=PNxxxxxxxx
```

This must be executed:

* using Twilio credentials
* **after** the number is successfully purchased/allocated

---

### 3. Persist A2P / Sender State

Update Callio DB to store:

**phone_numbers table (or equivalent)**

* `phoneNumberSid`
* `messagingServiceSid`
* `campaignType = lead_alerts`
* `a2pStatus = pending | ready | failed`
* `attachedAt`

Set:

* `a2pStatus = ready` only after Twilio confirms number added to Messaging Service

---

### 4. Error Handling & Retries

Implement:

* Retry logic if Twilio returns transient errors
* Fail fast if:

  * Messaging Service SID is invalid
  * Number is already attached elsewhere
* Log Twilio error codes/messages

If attachment fails:

* Set `a2pStatus = failed`
* Expose error for debugging

---

### 5. Callio API Response Update

When Callio provisions a number (or assigns it):

Return:

```json
{
  "phoneNumber": "+18135550123",
  "phoneNumberSid": "PNxxxx",
  "messagingServiceSid": "MGxxxx",
  "a2pStatus": "ready"
}
```

LeadBridge relies on this to know whether SMS can be sent.

---

### 6. (Optional but Recommended) Status Endpoint

Add:

```
GET /api/v1/phone-numbers/:id/status
```

Returns:

* A2P readiness
* Messaging Service attachment state

---

## PART 2 — LeadBridge: What to Implement

### 1. No Twilio Logic in LeadBridge

LeadBridge must:

* NEVER call Twilio APIs
* NEVER handle campaigns or Messaging Services

All compliance logic lives in Callio.

---

### 2. Store Sender Readiness

When LeadBridge receives number provisioning response from Callio:

Persist:

* `senderPhone`
* `senderMode = dedicated`
* `a2pStatus`

Do not attempt to send SMS unless:

```
a2pStatus === "ready"
```

---

### 3. Sending Messages

When a lead is created:

* LeadBridge sends message intent to Callio
* Callio sends via Messaging Service SID (not raw from-number)

LeadBridge should not care *how* the number was registered.

---

## PART 3 — Acceptance Criteria

### Functional

* [ ] New tenant signup provisions a Twilio phone number
* [ ] Number is automatically attached to Messaging Service
* [ ] No manual campaign assignment required
* [ ] SMS sending works immediately after provisioning
* [ ] Failures are logged and visible

### Architectural

* [ ] LeadBridge has zero Twilio knowledge
* [ ] Callio is the single source of truth for A2P compliance
* [ ] One campaign supports many numbers
* [ ] Numbers can be added dynamically at scale

### Non-Goals (Explicit)

* ❌ Per-tenant A2P campaign creation
* ❌ Tenant-branded customer messaging
* ❌ Marketing / promotional SMS

---

## Notes for the AI Coder

* Assume **US A2P 10DLC**
* Assume campaign is already approved
* Use **Messaging Service** as the campaign attachment mechanism
* Keep implementation provider-agnostic inside Callio (future WhatsApp / OpenPhone)

---

If you want, next I can:

* convert this into **Jira tickets**
* generate **Twilio API code snippets (Node / Python)**
* or create a **sequence diagram** showing tenant → Callio → Twilio → ready state
