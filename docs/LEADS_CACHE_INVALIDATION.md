# Leads Cache Invalidation Map

Prerequisite design document. **Read this before adding any Redis caching to `GET /v1/leads` or `GET /v1/leads/:id`.**

Purpose: guarantee that every code path which mutates `Lead`, `Conversation`, or `Message` state also invalidates the cached leads list / lead detail, so the UI never serves stale data across users' own actions or platform-driven events.

---

## Proposed cache keys (not yet implemented)

| Key | Scope | TTL | Notes |
|-----|-------|-----|-------|
| `leads:user:{userId}` | All leads for a user | 30s | Used by dashboards that span accounts |
| `leads:user:{userId}:biz:{businessId}` | Per-business leads list | 30s | Primary Messages page query |
| `lead:user:{userId}:{leadId}` | Lead detail | 60s | **userId included for cross-tenant safety** |
| `lead-messages:user:{userId}:{leadId}` | Message thread for a lead | 60s | Not enabled this phase; key reserved. userId included for cross-tenant safety. |

Invalidation pattern per user: `leads:user:{userId}*` + `lead:{leadId}` + `lead-messages:{leadId}`.

**All invalidation goes through the 5 helpers on `LeadCacheService`** (`src/common/cache/lead-cache.service.ts`):

| Helper | Keys deleted |
|---|---|
| `invalidateLeadList(userId)` | `leads:user:{userId}*` |
| `invalidateLeadDetail(leadId)` | `lead:{leadId}` |
| `invalidateLeadMessages(leadId)` | `lead-messages:{leadId}` |
| `invalidateLeadAndList(userId, leadId)` | list + detail |
| `invalidateLeadMessagesAndList(userId, leadId)` | list + detail + messages |

Callers MUST use these helpers. Never reach for `CacheService` directly from feature code — the helper names are the contract documented in this file.

**Invariants**:
- Every mutation MUST call the appropriate helper **after** the DB write commits. Never before — a concurrent reader could otherwise repopulate the cache from pre-commit state.
- Write-through only. Do not rely solely on TTL for any visible state change (status, new lead, new message).
- If a mutation lacks a reliable `userId` in scope, resolve it from the lead before invalidating. Never guess.
- When `CACHE_ENABLED=false` (kill switch), all helpers become no-ops and every read falls through to the DB. Tests in [src/common/cache/lead-cache.service.spec.ts](src/common/cache/lead-cache.service.spec.ts) cover this.

---

## 1. Lead created (webhook)

External platform emits a new-lead event → we upsert a `Lead` row and (usually) a `Conversation` + initial `Message`.

| # | Site | Platform | Invalidate |
|---|------|----------|-----------|
| 1.1 | [src/webhooks/webhooks.service.ts:309](src/webhooks/webhooks.service.ts#L309) — Thumbtack negotiation upsert | Thumbtack | `leads:user:{lead.userId}*`, `lead:{lead.id}` |
| 1.2 | [src/webhooks/webhooks.service.ts:546](src/webhooks/webhooks.service.ts#L546) — Thumbtack message-created branch upsert | Thumbtack | same |
| 1.3 | [src/webhooks/webhooks.service.ts:1622](src/webhooks/webhooks.service.ts#L1622) — Yelp webhook lead upsert | Yelp | same |
| 1.4 | [src/webhooks/webhooks.service.ts:350](src/webhooks/webhooks.service.ts#L350) — already emits `lead.created.${userId}` | (event) | Preferred hook: subscribe a listener in `CacheModule.onModuleInit` that runs `delPattern('leads:user:{userId}*')` + `del('lead:{lead.id}')`. Covers 1.1–1.3 centrally. |
| 1.5 | [src/webhooks/webhooks.service.ts:1653](src/webhooks/webhooks.service.ts#L1653) — second `lead.created.${userId}` emit | (event) | Same listener covers this. |

Recommendation: **subscribe to the existing `lead.created.${userId}` event** instead of sprinkling invalidation across webhook branches. Single source of truth.

## 2. Lead updated / status changed

Explicit status changes and derived field updates (customerPhone, customerName, price fields, tags).

| # | Site | Trigger | Invalidate |
|---|------|---------|-----------|
| 2.1 | [src/leads/lead-status.service.ts:302](src/leads/lead-status.service.ts#L302) — canonical status update | manual + derived | inline `invalidateLeadAndList(lead.userId, lead.id)` |
| 2.2 | [src/leads/lead-status.service.ts:230](src/leads/lead-status.service.ts#L230) — emits `lead.status.conflict.${userId}` | (event) | **central event listener** — `lead.status.conflict.*` |
| 2.3 | [src/leads/leads.controller.ts:247](src/leads/leads.controller.ts#L247) — `PATCH /v1/leads/:id` | manual edit | inline `invalidateLeadAndList(userId, id)` |
| 2.4 | [src/leads/leads.service.ts:547](src/leads/leads.service.ts#L547) — `sendMessage` links threadId | part of send | **covered by 4.1** (outbound parent invalidates) |
| 2.5 | [src/leads/leads.service.ts:760](src/leads/leads.service.ts#L760) — `sendQuote` sets status=quoted | manual send | inline `invalidateLeadAndList(userId, leadId)` at end of `sendQuote` |
| 2.6 | [src/leads/leads.service.ts:772](src/leads/leads.service.ts#L772) — `updateLeadStatus` | API call | inline `invalidateLeadAndList(userId, leadId)` |
| 2.7 | [src/leads/leads.service.ts:840](src/leads/leads.service.ts#L840) — `syncLeadStatus` | sync | inline `invalidateLeadAndList(userId, leadId)` when status changes |
| 2.8 | [src/leads/leads.service.ts:864](src/leads/leads.service.ts#L864) — private `upsertLead` | internal | **no direct invalidation** — callers (imports, webhook paths) invalidate; keeping private helper pure. Documented as intentional. |
| 2.9 | [src/leads/leads.service.ts:1076](src/leads/leads.service.ts#L1076) — `importThumbtackNegotiation` copies thumbtackStatus | internal | **covered by 5.1** (parent import invalidates once at end) |
| 2.10 | [src/leads/leads.service.ts:1159](src/leads/leads.service.ts#L1159) — `importMessagesForNegotiation` links threadId | internal | **covered by parent** (caller invalidates; see 2.13, 5.1, 5.4) |
| 2.11 | [src/leads/leads.service.ts:1258](src/leads/leads.service.ts#L1258) — `patchLeadDetails` | API call | inline `invalidateLeadAndList(userId, leadId)` |
| 2.12 | [src/leads/leads.service.ts:1388](src/leads/leads.service.ts#L1388) — `refetchLeadFromPlatform` | API call | inline `invalidateLeadAndList(userId, leadId)` |
| 2.13 | [src/leads/leads.service.ts:1515](src/leads/leads.service.ts#L1515) | `resyncMessages` | inline `invalidateLeadMessagesAndList(userId, leadId)` once at end |
| 2.14 | [src/leads/leads.service.ts:1622](src/leads/leads.service.ts#L1622) — `migrateLeadDates` admin script | admin one-off | inline `invalidateLeadList(userId)` once at end of migration loop |
| 2.15 | [src/webhooks/webhooks.service.ts:485](src/webhooks/webhooks.service.ts#L485) — link threadId (conversation-ensure path) | webhook | **covered by 1.x** (same handler emits `lead.created.${userId}`) |
| 2.16 | [src/webhooks/webhooks.service.ts:603](src/webhooks/webhooks.service.ts#L603) — link threadId (message-created path) | webhook | **covered by 1.x + 3.1** (emits `lead.created` or `sms.inbound`) |
| 2.17 | [src/webhooks/webhooks.service.ts:852](src/webhooks/webhooks.service.ts#L852) — `handleStatusChange` updateMany | webhook | inline: fetch lead userId+id then `invalidateLeadAndList(userId, leadId)`. Webhook has `externalRequestId` only — one extra findFirst to resolve. |
| 2.18 | [src/webhooks/webhooks.service.ts:1202](src/webhooks/webhooks.service.ts#L1202) — SMS inbound threadId link | webhook | **covered by 3.1** (same handler creates the Message row and emits `sms.inbound.${userId}`) |
| 2.19 | [src/webhooks/webhooks.service.ts:1436](src/webhooks/webhooks.service.ts#L1436) — Yelp opt-in phone updateMany | webhook | inline: fetch lead by `externalRequestId` + platform='yelp', then `invalidateLeadAndList(userId, leadId)` |
| 2.20 | [src/webhooks/webhooks.service.ts:1681](src/webhooks/webhooks.service.ts#L1681) — Yelp customerPhone patch | webhook | inline `invalidateLeadAndList(lead.userId, lead.id)` (lead already in scope) |
| 2.21 | [src/automation/automation.service.ts:742](src/automation/automation.service.ts#L742) — automation status update | automation run | inline `invalidateLeadAndList(lead.userId, lead.id)` |
| 2.22 | [src/integrations/yelp-integrations.controller.ts:113](src/integrations/yelp-integrations.controller.ts#L113) — Yelp integration update | integration | inline `invalidateLeadAndList(userId, existing.id)` |
| 2.23 | [src/integrations/service-flow/sf-inbound-status.service.ts:295](src/integrations/service-flow/sf-inbound-status.service.ts#L295) — ServiceFlow inbound updateMany | ServiceFlow inbound | inline: resolve userId (one findFirst by `externalRequestId`), then `invalidateLeadAndList(userId, leadId)` |

**Consolidation candidate**: route all lead status writes through `lead-status.service.ts` and invalidate once there. Many of rows 2.4–2.14 may already go through that service; audit before scattering `del` calls.

## 3. Message received (inbound)

Webhook brings inbound platform message → message row + possibly conversation + lead `lastMessageAt` update.

| # | Site | Platform | Invalidate |
|---|------|----------|-----------|
| 3.1 | [src/webhooks/webhooks.service.ts:1212](src/webhooks/webhooks.service.ts#L1212) — SMS inbound message create | Twilio | **covered by 3.2 event** — same handler emits `sms.inbound.${userId}` |
| 3.2 | [src/webhooks/webhooks.service.ts:1303](src/webhooks/webhooks.service.ts#L1303) — emits `sms.inbound.${userId}` | (event) | **central event listener** — `sms.inbound.*` → `invalidateLeadMessagesAndList(userId, leadId)` |
| 3.3 | Thumbtack/Yelp inbound message paths ([webhooks.service.ts:546, 1622](src/webhooks/webhooks.service.ts#L546)) | webhook | **covered by 1.x** — same handlers emit `lead.created.${userId}` which invalidates list + detail; message subresource TTL-stale for up to 60s until list/detail cache is turned on. For Yelp, `getYelpMessages` is NOT cached in this phase (explicitly deferred — see step 4 of implementation order). |

## 4. Message sent (outbound)

App-originated message (manual reply, automation, follow-up, bulk).

| # | Site | Trigger | Invalidate |
|---|------|---------|-----------|
| 4.1 | [src/leads/leads.service.ts:378](src/leads/leads.service.ts#L378) — `sendMessage` write | manual send | inline `invalidateLeadMessagesAndList(userId, leadId)` at end of method |
| 4.2 | [src/leads/leads.service.ts:599](src/leads/leads.service.ts#L599) — `sendMessage` upsert branch | manual send | **covered by 4.1** (same method, single invalidation at method exit) |
| 4.3 | [src/notifications/notifications.service.ts:495](src/notifications/notifications.service.ts#L495) — automation-driven send | automation | inline `invalidateLeadMessagesAndList(lead.userId, lead.id)` |
| 4.4 | [src/notifications/notifications.service.ts:1293](src/notifications/notifications.service.ts#L1293) — follow-up send | follow-up | inline `invalidateLeadMessagesAndList(lead.userId, lead.id)` |
| 4.5 | `sendBulkMessages` entrypoint — [src/leads/leads.service.ts:1711](src/leads/leads.service.ts#L1711) | bulk | fans out to 4.1 — **covered transitively**. For efficiency, after the loop call a single `invalidateLeadList(userId)` (list order shifts once). |

## 5. Platform sync (cron / refetch / import)

Sync flows that can create OR update many leads at once.

| # | Site | Trigger | Invalidate |
|---|------|---------|-----------|
| 5.1 | [src/leads/leads.service.ts:918](src/leads/leads.service.ts#L918) — `importThumbtackNegotiation` | API | inline `invalidateLeadAndList(userId, storedLead.id)` at end |
| 5.2 | [src/leads/leads.service.ts:1273](src/leads/leads.service.ts#L1273) — `importThumbtackNegotiations` (bulk) | API | **single** `invalidateLeadList(userId)` after the loop — **not per-lead** |
| 5.3 | [src/leads/leads.service.ts:1371](src/leads/leads.service.ts#L1371) — `refetchLeadFromPlatform` | API | **covered by 2.12** |
| 5.4 | [src/leads/leads.service.ts:1408](src/leads/leads.service.ts#L1408) — `resyncMessages` | API | **covered by 2.13** |

## 6. Extension sync (Chrome extension)

The LeadBridge-Sync-Thumbtack extension sends collected lead IDs; backend later hydrates them into real leads.

| # | Site | Trigger | Invalidate |
|---|------|---------|-----------|
| 6.1 | [src/integrations/integrations.controller.ts:48](src/integrations/integrations.controller.ts#L48) — `POST /leads/collect` | extension | inline `authService.invalidateMeCache(userId)` (collectedLeads count changes). No Lead rows written. |
| 6.2 | [src/integrations/integrations.controller.ts:97](src/integrations/integrations.controller.ts#L97) — `PATCH /leads/mark-imported` | extension | inline: `authService.invalidateMeCache(userId)`. Downstream hydration (if any) goes through `importThumbtackNegotiation` — already handled by 5.1. |
| 6.3 | [src/integrations/integrations.controller.ts:163](src/integrations/integrations.controller.ts#L163) — `POST /leads/reimport` | extension | same as 6.2. Leads hydration covered transitively. |
| 6.4 | [src/integrations/integrations.controller.ts:176](src/integrations/integrations.controller.ts#L176) — `DELETE /leads` | extension | inline `authService.invalidateMeCache(userId)` |

## 7. Follow-up enrollment / update

Enrollment does not mutate Lead rows directly, but it flips derived UI state (waitingSince / nextFollowUpAt / followUpState) that the lead list renders.

| # | Site | Trigger | Invalidate |
|---|------|---------|-----------|
| 7.1 | `enrollInSequence` in follow-up-engine service | manual/auto enroll | inline `invalidateLeadAndList(userId, leadId)` at the end of `enrollInSequence` |
| 7.2 | Enrollment status transitions (suggested / approved / skipped / expired / stopped) | scheduler + API | inline `invalidateLeadAndList(userId, leadId)` at each state-change write site in follow-up-engine |
| 7.3 | [src/follow-up-engine/follow-up-scheduler.service.ts:481](src/follow-up-engine/follow-up-scheduler.service.ts#L481) — emits `followup.suggested.${userId}` | (event) | **central event listener** — `followup.suggested.*` → `invalidateLeadAndList(userId, leadId)` (covers the scheduler path) |

## 8. Account switch / platform reconnect

Saved-accounts cache is already invalidated on connect/disconnect/refresh (see `platform.service.ts`). For **leads**, a reconnect that re-attaches webhooks or recreates a SavedAccount can flip which leads are visible through the `businessId` filter.

| # | Site | Trigger | Invalidate |
|---|------|---------|-----------|
| 8.1 | `PlatformService.saveAccount` — OAuth reconnect | OAuth | inline `invalidateLeadList(userId)` (new `businessId` becomes visible) |
| 8.2 | `PlatformService.removeSavedAccount` with `deleteLeads=true` → [src/platforms/platform.service.ts:1352](src/platforms/platform.service.ts#L1352) | disconnect | inline `invalidateLeadList(userId)` |
| 8.3 | `PlatformService.disconnect` | disconnect | inline `invalidateLeadList(userId)` |
| 8.4 | Yelp controller `auth/disconnect` / `businesses/:id` delete | disconnect | inline `invalidateLeadList(userId)` |
| 8.5 | [src/integrations/integrations.service.ts:484](src/integrations/integrations.service.ts#L484) — `deleteMany` leads | admin/integration | inline `invalidateLeadList(userId)` |

## 9. Manual lead edits (UI)

| # | Site | Trigger | Invalidate |
|---|------|---------|-----------|
| 9.1 | [src/leads/leads.controller.ts:247](src/leads/leads.controller.ts#L247) — `PATCH /v1/leads/:id` | UI edit | covered by 2.3 |
| 9.2 | `patchLeadDetails` — [src/leads/leads.service.ts:1233](src/leads/leads.service.ts#L1233) | UI edit | covered by 2.11 |

## 10. Organization / team reassignment

Changing `SavedAccount.organizationId` via `teams.service.ts` affects which users can see an account's leads through `getAccessibleAccountIds()` (per memory, not yet wired).

**Decision for this phase**: **no invalidation needed**. `getAccessibleAccountIds()` is not yet wired into the leads query path, so `SavedAccount.organizationId` changes do not currently affect the `leads:user:{userId}` cache. This row becomes a TODO: re-audit once team-scoped leads queries ship.

## 11. Call-connect test leads

[src/call-connect/call-connect.service.ts:1044](src/call-connect/call-connect.service.ts#L1044) — test-lead upsert.

**Decision**: **no invalidation needed**. Test leads are created with a fixed customer name/phone for Sigcore handshake testing; they are filtered out of normal list queries by other means and the test flow does not depend on the Messages UI reflecting them in real time. If this changes, add `invalidateLeadAndList(test.userId, test.id)`.

---

## Recommended implementation order (once this doc is approved)

1. **Add a `LeadCacheInvalidator` listener** in `CacheModule` that subscribes to:
   - `lead.created.${userId}` → `delPattern('leads:user:{userId}*')`, `del('lead:{payload.id}')`
   - `lead.status.conflict.${userId}` → same
   - `sms.inbound.${userId}` → `del('lead-messages:{payload.leadId}')`, `del('lead:{payload.leadId}')`, `delPattern('leads:user:{userId}*')`
   - `followup.suggested.${userId}` → `del('lead:{payload.leadId}')`, `delPattern('leads:user:{userId}*')`

   This covers categories 1, 3 (if new events added for Yelp inbound), and 7 centrally without touching each write site.

2. **Add explicit invalidation** at the write sites not covered by events:
   - `sendMessage` paths (category 4) — these don't currently emit events; add them or invalidate inline.
   - `updateLeadStatus` / `patchLeadDetails` — inline invalidation in the service method.
   - `sendBulkMessages` — single invalidation at the end of the loop.
   - `importThumbtackNegotiations` (bulk) — single invalidation at the end.
   - Webhook `updateMany` paths (2.17, 2.19, 3.3) — since `updateMany` returns count only, fetch affected lead IDs first OR just `delPattern` by userId.
   - ServiceFlow `sf-inbound-status.service.ts:295` — resolve userId from the update target.
   - Yelp integrations controller (2.22).

3. **Cache `GET /v1/leads` and `GET /v1/leads/:id`** — only after steps 1 and 2 are in place.
   - Start with `GET /v1/leads?businessId=...` (single-account filter) — it's the hottest path.
   - TTL: 30s for list, 60s for detail. Short enough that any missed invalidation reconciles within a minute.
   - No caching for filtered queries with `limit`/`status` until we know the top 2-3 filter shapes and can size keys for them.

4. **Add `lead-messages:{leadId}`** last — Yelp `getYelpMessages` is the slowest call in the app, but it has the most invalidation paths (every inbound + outbound message).

## Keys to audit before shipping any of the above

- Every `prisma.lead.update*` call listed — confirm userId is resolvable in the surrounding scope (from `lead.userId` after update, or passed in).
- Every `prisma.message.create` call — confirm `conversationId → lead.id → lead.userId` chain is cheap, or pass `userId` through the call stack.
- Identify any `prisma.lead.*` / `prisma.message.*` mutations added AFTER this document was written. Grep:
  ```
  prisma\.(lead|message|conversation)\.(create|update|delete|upsert)
  ```
  Every new site must map to one of categories 1–11 or justify why no invalidation is needed.

## Known risk: staging + production double-write

Staging and production share the Supabase DB (per project memory). If they also share a Redis instance, the env-prefixed keys (`lb:v1:staging:` vs `lb:v1:production:`) already isolate them. Verify `NODE_ENV` is set correctly on each Railway service before first deploy.
