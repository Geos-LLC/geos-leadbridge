# Session Handoff — April 10, 2026

## What was done this session

### Follow-Up System (major rework)
- Yelp token chain revocation fixed (health check + sendMessage 401 retry)
- Scheduler: retry on failure, auto-reset stuck enrollments, advisory lock (7001)
- Proactive token refresh: advisory lock (7002), re-read from DB before refresh
- Duplicate step guard, single enrollment per conversation
- Historical enrollment via "Follow up historical leads" checkbox
- Resume follow-ups after conversation (configurable delay: 1h-1w)
- Quiet hours (don't send at night, default 10pm-8am)
- Skip terminal leads (done/scheduled/hired/archived/lost)
- Re-enroll delay: only skip to 24h+ step when customer replied AFTER business message
- Yelp echo detection: moved handleCustomerReply AFTER user_type=BIZ check
- FOLLOWUP_SCHEDULER=false on staging to let production handle it

### AI Conversation (new feature)
- Separate aiConversationEnabled boolean on SavedAccount (independent from followUpMode)
- Auto-replies to customer messages when enabled
- AI Conversation Rules: stop on opt-out/booked/price agreed, max replies
- Strategy selector: Auto/Hybrid/Price/Qualify/Convert/Phone

### UI Restructure
- New Lead Handling (Instant Reply + New Lead Alerts)
- Customer Contact (Instant Text + Instant Call)
- Ongoing Communication (Follow-ups + AI Conversation as separate toggles)
- All switches blue-600, all save buttons blue-600
- Multiple time windows for availability
- Save button spinner + disabled state
- LeadBridge Number (was Bot Number)

### CRM Webhook API
- CrmWebhookSubscription model, HMAC-SHA256 signed
- Events: lead.created, message.received, message.sent, lead.status_changed
- Normalized payload with Sigcore identity fields

### System Health Monitor
- AccountHealthStatus table (source of truth, not error logs)
- Hourly health cron at :10 (advisory lock 7003)
- SendGrid alerts (event-based: alert on open, 24h silence, 48h reminders, recovery)
- Error dedup by (category, accountId, platform, code)
- Dashboard + Layout banner read from server health
- Fix Now opens reconnect modal for affected account

### Message Improvements
- AI vs manager distinction (senderType field)
- Phone detection from messages, auto-save to lead
- Clickable phone numbers in messages
- Lead status badge in conversation header
- Next follow-up + AI conversation status in right panel

## What needs to be done NEXT

### 1. Follow-up step timing based on messages already sent
**Problem:** When re-enrolling, the system starts from step 0 regardless of how many messages were already sent. Jeffrey got the same "checking in" message 5 times.

**Fix needed:**
- Count ALL pro messages sent to this conversation
- Map that count to the step sequence (e.g., 3 messages sent → start from step 4)
- Don't just count follow-up executions — count ALL messages (manual + auto + follow-up)
- The step delays should apply relative to the LAST message sent, not enrollment creation

### 2. Right panel — show timing label for next follow-up
**Current:** Shows "Next follow-up: Apr 11, 8:00 AM" (just a date)
**Needed:** Show relative time + step info: "Next follow-up: in 3 days (Step 5 of 11)"

### 3. Right panel — show next message preview
**Needed:** Show what message will be sent next, with:
- Edit button to modify before sending
- Cancel/Skip button to skip this step
- If AI mode: generate preview on demand
- If template mode: show the template content

### 4. Follow-up message quality
- The 10-minute minimum gap is in place but should probably be longer for non-adjacent steps
- The AI sees all previous messages but still sometimes generates similar content
- Consider using temperature variation or explicit "banned phrases" from previous messages

### 5. Dashboard improvements remaining
- The old client-side health logic in Dashboard (Account Status card, lines 602-665) still uses savedAccounts/webhookId — should use server health
- System Status uses server health (done) but Account Status card doesn't

## Key files modified this session
- `src/follow-up-engine/follow-up-scheduler.service.ts` — scheduler cron, quiet hours, min gap
- `src/follow-up-engine/follow-up-engine.service.ts` — enrollInSequence, evaluateThread, step skipping
- `src/follow-up-engine/follow-up-engine.controller.ts` — settings save, historical enrollment, bulk-activate
- `src/follow-up-engine/follow-up-generator.service.ts` — AI dedup, pricing, request details
- `src/automation/automation.service.ts` — AI Conversation auto-reply
- `src/webhooks/webhooks.service.ts` — Yelp echo detection, CRM webhook emit
- `src/leads/leads.service.ts` — sendMessage retry, phone detection, enrollment after send
- `src/monitoring/monitoring.service.ts` — health cron, SendGrid, error dedup
- `src/platforms/platform.service.ts` — advisory lock, re-read before refresh
- `src/crm-webhooks/` — new module
- `frontend/src/pages/Services.tsx` — UI restructure
- `frontend/src/pages/Messages.tsx` — right panel, phone detection, AI badge
- `frontend/src/pages/Dashboard.tsx` — server health status
- `frontend/src/components/Layout.tsx` — server health banner

## Environment state
- Staging: FOLLOWUP_SCHEDULER=false, SENDGRID_API_KEY set
- Production: FOLLOWUP_SCHEDULER not set (defaults to enabled), SENDGRID_API_KEY set
- Advisory locks: 7001 (follow-up), 7002 (token refresh), 7003 (health check)
- SendGrid sender needs domain verification (leadbridge360.com) or single sender verification
- Jacksonville TT token needs reconnection
