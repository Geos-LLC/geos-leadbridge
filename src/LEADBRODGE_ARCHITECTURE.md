LeadBridge Application Architecture
Backend (NestJS) — 16 modules, 31 Prisma models
Module	Purpose
auth	Registration, JWT, password reset, OAuth
webhooks	Inbound events from Thumbtack + Sigcore SMS
notifications	SMS alerts via Sigcore: settings, rules, delivery logs
automation	Auto-reply rules (triggers, delays, templates)
call-connect	Instant call routing (agent↔lead bridge, voicemail)
platforms	Multi-platform abstraction (Thumbtack, Yelp, Angi, Bark)
leads	Lead normalization, status tracking
analytics	Metrics, conversion tracking, caching
sigcore	HTTP client to Sigcore telephony API
templates	Message template CRUD
integrations	Chrome extension data (budgets, lead collection)
conversation-sync	Read-only OpenPhone conversation sync for AI analysis (not a routing path)
stripe	Subscription billing
users	Profile, phone sync
admin	User mgmt, tenant number reassignment, pricing + A2P config
common	Guards (JWT, Impersonation, FeatureGate), decorators, Prisma
Frontend (React/Vite) — 21 pages, 20 components, 3 Zustand stores
Layer	Key Items
Pages	Dashboard, Messages (Lead Activity), Analytics, Services (Automation), Settings, SmsHistory, Admin (3 pages)
Stores	authStore (user + impersonation), appStore (accounts, leads, analytics cache), notificationStore (toasts)
API	1 monolithic api.ts (1,419 lines, 16 namespaces, ~165 endpoints)
Types	481 lines, 30+ interfaces
Global Issues I See
1. Account scoping is inconsistent across the app
Dashboard leadsToday: queries by userId only, NO businessId filter
Lead Activity: filters by savedAccounts.businessId client-side
Analytics: sometimes passes businessId, sometimes doesn't
Result: metric mismatches like "1 lead today, 0 in Lead Activity"
2. Webhook broadcast → multi-account contamination
Sigcore broadcasts message.inbound to ALL workspace subscriptions (fix committed but pattern exists elsewhere)
LeadBridge handleInboundSms processes for ALL accounts that receive the webhook
The "isOwner" check was too permissive (just fixed) but similar patterns may exist in other handlers
3. Business-phone identity is still mirrored across 3 tables
User.businessPhone is the source of truth, mirrored into NotificationSettings.destinationPhone, CallConnectSettings.agentPhoneE164, and NotificationRule.toPhone at save time (syncBusinessPhoneToAccounts).
Customer-facing routing was consolidated 2026-04-24 (PRs #104–#106): TenantPhoneNumber is now the only source of truth for the dedicated number, resolved via resolveBotPhone. Pool/BYO/OpenPhone routing removed.
Sync logic for business phone still lives in users.service (syncBusinessPhoneToAccounts) — could be collapsed to a single "read User.businessPhone at send time" model.
4. No request-level account context
Backend doesn't know "which account is the user looking at" — each endpoint either takes accountId as a param or doesn't scope at all
Frontend passes accountId inconsistently (some endpoints get it, Dashboard stats don't)
5. Pending message queues are dual/redundant
PendingAutomatedMessage (automation rules) and PendingNotificationMessage (notification rules) are separate tables with nearly identical schemas
Different processing logic, different failure handling
6. Frontend data fetching has no cache invalidation
Module-level caches (_settingsCache, _messagesLoaded) survive navigation but have no invalidation on data changes
appStore persists analyticsCache and dashboardStats across sessions — can show stale data after impersonation switches
No React Query/SWR — manual Promise.all everywhere
7. api.ts is a 1,419-line monolith
16 namespaces, ~165 endpoints, no code splitting
Each namespace is an object literal (not a class), no shared error handling patterns
8. Circular dependencies everywhere
6 modules use forwardRef() — WebhooksModule is the hub that depends on almost everything
webhooks.service.ts injects 5 other services directly
9. Lead ownership model is ambiguous
Lead.userId ties to the User, but Lead.businessId ties to the Thumbtack business
Lead queries sometimes scope by userId, sometimes by businessId, sometimes by savedAccount.businessId
The Sigcore inbound SMS handler tries to match by phone → lead, scoped by account's businessId — fails silently when no lead found and broadcasts to wrong accounts
10. Impersonation doesn't fully isolate
Settings profile fetch was broken (profileResult?.user instead of profileResult) — just fixed
Dashboard stats come from appStore cache which persists across impersonation switches
No server-side enforcement that impersonated requests are read-only or scoped