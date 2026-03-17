TASK — Fix CallConnect Multi-Tenant Collision in Sigcore (Tenant-Scoped Routing)
Problem

Currently Sigcore resolves CallConnect settings at the workspace level.

Architecture today:

Sigcore workspace (LeadBridge platform)
 ├── tenant: Spotless Homes Jacksonville
 ├── tenant: Spotless Homes Tampa
 └── tenant: Spotless Homes Miami

However, when LeadBridge calls:

POST /api/internal/call-connect/start

Sigcore resolves the workspace using @WorkspaceId() and all tenant API keys resolve to the same workspaceId.

Result:

Only one CallConnect settings row exists per workspace

Multiple LeadBridge accounts overwrite each other’s configuration

Calls route incorrectly (wrong bot → wrong agent)

This is the root cause of the recurring bug.

Goal

Make CallConnect configuration and routing tenant-scoped instead of workspace-scoped.

Each LeadBridge business must have its own CallConnect configuration.

High Level Solution

CallConnect must be resolved by:

workspaceId + businessId + botNumberE164

NOT just:

workspaceId

Additionally:

Call start requests must include the bot number explicitly.

Settings must be stored per tenant/business.

PART 1 — Update CallConnect Start API
Endpoint
POST /api/internal/call-connect/start
Current body (simplified)
{
  businessId,
  leadPhone,
  agentHint
}
New body

Add explicit bot number:

{
  businessId,
  leadPhone,
  fromNumberHint,
  agentHint
}

Where:

fromNumberHint = botNumberE164

This tells Sigcore which bot number the session belongs to.

PART 2 — Change CallConnect Settings Lookup
File

CallConnect service in Sigcore.

Current lookup (problem)
SELECT *
FROM call_connect_settings
WHERE workspaceId = ?
LIMIT 1
New lookup
SELECT *
FROM call_connect_settings
WHERE workspaceId = ?
AND businessId = ?
AND botNumberE164 = ?
LIMIT 1

Lookup parameters:

workspaceId  ← from API key
businessId   ← from request
botNumberE164 ← fromNumberHint

If not found:

throw CALL_CONNECT_SETTINGS_NOT_FOUND

Do NOT fallback to workspace-level configuration.

PART 3 — Update CallConnect Settings Write API
Endpoint
POST /api/internal/call-connect/settings
Required fields
{
  businessId,
  botNumberE164,
  agentPhoneE164,
  mode,
  agentAcceptDigits
}
DB uniqueness constraint

Add index:

UNIQUE(workspaceId, businessId, botNumberE164)

This ensures:

each tenant can configure their own bot

multiple tenants in same workspace do not collide

PART 4 — Enforce Bot Number Ownership

When saving CallConnect settings:

Verify:

botNumberE164 belongs to the same tenant/business

Possible sources:

dedicated Twilio numbers owned by tenant

pool numbers assigned to tenant (if applicable)

Reject if:

BOT_NUMBER_NOT_OWNED
PART 5 — Update CallConnect Session Start Logic

When starting a call:

POST /api/internal/call-connect/start

Steps:

Resolve workspace from API key

Validate businessId

Validate fromNumberHint

Load CallConnect settings using new query

Use

settings.agentPhoneE164

as dial target.

Ignore agentHint unless debugging.

PART 6 — Remove Workspace-Level Fallback

Delete any logic that:

reads CallConnect config by workspaceId only

falls back to tenant metadata

falls back to BYO forwarding number

Routing priority must be:

CallConnect settings
OR fail

Never silently fallback.

PART 7 — LeadBridge Changes

Update CallConnect calls in LeadBridge.

File
call-connect.service.ts
When starting call

Send:

POST /call-connect/start

{
  businessId,
  leadPhone,
  fromNumberHint: botNumber,
  agentHint: agentPhone
}

Where:

botNumber = configured bot number for that account
PART 8 — Logging Improvements

Add logs in Sigcore when starting session:

CallConnect start
workspaceId
businessId
botNumber
agentPhone
sessionId

Example:

CallConnect start:
workspace=1bcbb4e0
business=45ea9010
bot=+16562188788
agent=+12483462681
PART 9 — Data Migration

Existing table call_connect_settings likely contains rows with only:

workspaceId

Migration:

Add businessId column if missing

Populate it from existing data

Add uniqueness constraint

Expected Result

After this change:

Each LeadBridge account can have independent configuration.

Example:

workspace: LeadBridge

tenant: Jacksonville
bot: +16562188788
agent: +12483462681

tenant: Tampa
bot: +16562231592
agent: +18139212100

Both can operate simultaneously without conflict.

Acceptance Tests
Test 1 — Two tenants

Tenant A:

bot: +16562188788
agent: +12483462681

Tenant B:

bot: +16562231592
agent: +18139212100

Both calls route correctly.

Test 2 — Wrong tenant

Start call with bot belonging to different tenant.

Expected:

BOT_NUMBER_NOT_OWNED
Test 3 — Settings isolation

Updating CC settings in tenant A must NOT affect tenant B.

Result

CallConnect becomes:

workspace-safe
tenant-safe
bot-number scoped

and eliminates the repeated routing bug permanently.