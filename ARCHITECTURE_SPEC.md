# LeadBridge Architecture Spec (Definitive)

## Core Entities

```
User (1 login)
  └── SavedAccount (many Thumbtack businesses)
        ├── NotificationSettings (1)
        ├── CallConnectSettings (1)
        ├── AutomationRules (many)
        ├── NotificationRules (many)
        └── Leads (many, via businessId)
```

## Rules

### Users & Businesses
- One LeadBridge user can have multiple Thumbtack businesses (SavedAccounts)
- **Users are strictly isolated** from each other — no cross-user data leaks
- **Businesses are isolated** in: leads, templates, automation rules, notification rules
- **Businesses share** across the same user: agent phone number, bot number

### Phone Numbers
- **Only ONE phone type exists: Dedicated** (assigned during signup via Sigcore provisioning)
- No pool numbers. No BYO/OpenPhone numbers. Remove all pool/BYO logic.
- Every new user account gets ONE dedicated number, shared across all their businesses
- **One bot number** per user (outbound SMS, calls) — lives on Sigcore side as source of truth
- **One agent number** per user (the human's real phone) — where alerts/forwards go

### Single Source of Truth for Agent Phone
These 4 fields must ALWAYS be the same value — consolidate to ONE field:
- `User.businessPhone`
- `NotificationSettings.destinationPhone`
- `CallConnectSettings.agentPhoneE164`
- `NotificationRule.toPhone`

**Source of truth**: `User.businessPhone` — all others derive from it or are eliminated.

### Dashboard & Filtering
- Dashboard shows ALL businesses combined by default
- User can filter to a single business via account selector
- When filtered: Dashboard stats, Lead Activity, Analytics all scope to that businessId
- When "All": show aggregate across all businesses

### Inbound SMS (customer → bot number)
- Sigcore sends webhook with metadata: businessId + customer phone
- LeadBridge matches to the correct business using this metadata
- Message is forwarded to the agent (business) phone number
- Message is stored in Lead Activity for that customer
- If no matching lead: still forward to agent phone, but don't show in Lead Activity

### Inbound Calls (customer → bot number)
- Same routing: use metadata to identify the business
- Call forwards to agent phone
- Call Connect settings (templates, whisper, etc.) are per-business

### Agent texts bot number
- Keep current behavior: send guidance message ("this is your LeadBridge number")

### New Lead Flow
Depends on what's enabled for the business:
1. **Lead Notification** (notification rule enabled):
   - SMS alert sent to agent phone
2. **Customer Communication** (automation rule enabled):
   - Auto-reply to customer via Thumbtack API
3. **Customer Texting** (if enabled):
   - Customer can text the bot number, forwarded to agent
4. **Call Connect** (if enabled):
   - Calls between agent and customer via bot number

### Admin / Impersonation
- Admin can view AND edit settings for any user
- Admin dashboard shows accounts with business names listed
- When impersonating: admin sees exactly what the user sees, can modify settings
- All changes are logged

## What to Remove/Simplify

### Phone Tables: Keep only TenantPhoneNumber
- **DELETE**: `PhonePool` table, `PhonePoolAssignment` table
- **DELETE**: All pool allocation logic (`admin-phone-pool.service.ts`)
- **DELETE**: BYO/OpenPhone connection flow (`sigcoreProvider`, `sigcoreFromPhone` as OpenPhone)
- **KEEP**: `TenantPhoneNumber` — one per user, status ACTIVE
- **Admin dashboard**: one table for assigned numbers (remove Pool and BYO tables)

### Agent Phone: Consolidate to User.businessPhone
- **Source of truth**: `User.businessPhone`
- **Remove or derive**: `NotificationSettings.destinationPhone`, `CallConnectSettings.agentPhoneE164`
- **NotificationRule.toPhone**: always read from `User.businessPhone` at send time, don't store separately
- **Single edit point**: Settings page "Business Phone" field

### Notification Settings: Simplify sender mode
- Remove `senderMode` (shared/dedicated/openphone) — always "dedicated"
- Remove `sigcoreProvider` field — always Sigcore/Twilio via dedicated number
- Keep `sigcoreApiKey`, `sigcoreFromPhone` (= the dedicated bot number), `sigcoreWorkspaceId`, `sigcoreTenantId`
