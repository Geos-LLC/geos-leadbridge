TASK — LEADBRIDGE (UI + Triggering + Billing Gates)
Goal

Add Instant Call Connect to LeadBridge:

Settings UI (toggle + mode switch)

Trigger Sigcore on new lead creation

Show call-connect status in lead activity

Enforce tier rules:

Base tiers: BOT number (shared caller ID)

Higher tier later: personal business number (caller_id_strategy switch)

Deliverables

DB changes (LeadBridge side) for settings + status display

UI: settings section + per-lead status timeline

Backend: trigger Sigcore start/cancel + receive status webhooks

Feature gating by subscription tier

1) LeadBridge DB

Add:

automation_settings

business_id pk

call_connect_enabled boolean

call_connect_mode enum AGENT_FIRST|PARALLEL

ring_timeout_seconds

agent_strategy

timestamps

lead_call_connect

lead_id

sigcore_session_id

status

last_event_at

result_reason nullable

recording_url nullable

timestamps

2) Settings UI

Under Automation (or System Health → click-through):
Instant Call Connect

Toggle ON/OFF

Mode switch:

“Agent first (recommended)”

“Parallel (fastest)”

Ring timeout (20 default)

Agent routing (Owner / Round-robin / On duty)

(Optional) Quiet hours

Copy text:

“Starter plans use a shared bot number for calls/SMS.”

“Upgrade to Pro+ to use your own business number.”

3) Trigger flow on new Thumbtack lead

When LeadBridge ingests a new lead (or first message arrives):

Check call_connect_enabled

If enabled:

Call Sigcore:
POST /internal/call-connect/start
with businessId, leadId, leadPhoneE164, leadSummary

Save sigcore_session_id and status CREATED

Add cooldown logic:

Do not trigger if lead already had a call-connect session in last X minutes

4) Receive Sigcore events

Expose webhook endpoint:
POST /webhooks/sigcore/call-connect

verify signature

update lead_call_connect.status

append timeline to lead activity feed

show UI badges: “Connecting… / Missed / Connected”

5) Tier enforcement

Implement a function canUseCallConnect(businessId):

Starter: allowed but uses shared bot number (no UI for caller id)

Pro/Enterprise: later allow “Use my business number”

For now, LeadBridge doesn’t choose number—Sigcore uses bot number by default.
Later: pass callerIdStrategy or tier claim in the /start payload.

6) UX in Lead Activity

On the lead details page show a “Call Connect” card:

Status

Attempt count

Result

“Call recording” link (later)

Timestamped events