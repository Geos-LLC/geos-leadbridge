🔷 Big Picture Architecture
LeadBridge  →  Sigcore  →  Twilio (SMS)
                     ↓
               Webhooks (incoming SMS)
                     ↓
                 LeadBridge UI

Sigcore owns:

sending SMS

receiving SMS

message status

rate limiting

number selection

LeadBridge owns:

templates

automation logic

UI

billing/tier logic

🔷 Step 1 — Decide Number Strategy (Important)

Since you said:

shared bot number for lower tier, personal number for higher

Do this:

For now (MVP)

1 shared Twilio number per region (or even 1 total)

Used for:

SMS

Calls

Call Connect

Later:

Per-business number

Simply switch from_number in Sigcore

🔷 TASK — LEADBRIDGE (Automation + UI)
🎯 Goal

Trigger SMS automatically and display conversation in lead UI.

1️⃣ On New Lead Event

When Thumbtack lead arrives:

If:

Auto-reply enabled

Business within hours

Call:

POST Sigcore /internal/messages/send

Template example:

Hi {{firstName}}, this is {{businessName}}. 
We just received your request for {{jobType}} in {{location}}.
When would be a good time to call you?
2️⃣ Follow-Up Automation

Add scheduler:

10 min if no reply

1 hour

24 hours

Before sending:

Check if inbound message exists

Cancel if customer replied

3️⃣ UI

Inside Lead Activity page:

Add:

Conversation panel

Real-time updates

Status indicators

Manual send message button

Status icons:

✓ Sent

✓✓ Delivered

⚠ Failed