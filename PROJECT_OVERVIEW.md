1. Project Overview & Name Suggestion
Project name: thumbtack-bridge 
Type: Standalone microservice (REST + Webhooks)
Language recommendation: Node.js + TypeScript + FastAPI 
2. Core Responsibilities of This Backend

Securely authenticate pros with Thumbtack (OAuth 2.0)
Pull leads, jobs, messages, negotiations
Send messages and quotes to customers
Receive real-time updates via Thumbtack webhooks
Expose clean, versioned API for your web/mobile apps (and later your CRM)
Store only what is necessary (tokens, sync state, message history if you want chat UI)

3. Database Schema (Supebase)
SQLusers (your app users / pros)
├── id (uuid or bigint)
├── email
├── name
├── thumbtack_connected (boolean)
├── thumbtack_user_id (from Thumbtack)
├── created_at, updated_at

thumbtack_credentials
├── user_id → users.id
├── access_token (encrypted)
├── refresh_token (encrypted)
├── expires_at
├── scope
├── created_at, updated_at

thumbtack_leads (optional – cache/sync)
├── id (uuid)
 user_id
 thumbtack_request_id (Thumbtack’s ID)
 customer_name, customer_phone, customer_email
 message, budget, postcode, status, etc.
 raw_json (full payload)
 synced_to_crm (boolean)
 created_at

thumbtack_conversations (if you want full chat history inside your app)
├── id
├── user_id
├── thumbtack_thread_id
├── last_message_at
├── unread_count
└── etc.
Use Prisma (Node.js) for migrations.
4. Must-Have API Endpoints (v (v1)
Base URL: https://api.yourdomain.com/v1/thumbtack
textGET    /auth/url                     → returns Thumbtack OAuth login URL
GET    /auth/callback                → Thumbtack redirects here after consent
POST   /auth/refresh                 → refresh expired access token (internal or cron)

GET    /leads                        → paginated list of leads
GET    /leads/:request_id            → single lead detail
POST   /leads/:request_id/message    → send message to customer
POST   /leads/:request_id/quote      → send quote

GET    /conversations                → list of all message threads
GET    /conversations/:thread_id     → messages in thread (paginated)
POST   /conversations/:thread_id/message → send message

POST   /webhooks/thumbtack           → Thumbtack sends events here
All endpoints require your own JWT (not Thumbtack token) → you control who can use the service.
5. OAuth 2.0 Flow You Must Implement

User clicks “Connect with Thumbtack” in your web/mobile app
Redirect to:
https://www.thumbtack.com/api/oauth2/authorize?client_id=XXX&redirect_uri=YYY&response_type=code&scope=requests:read requests:write messages:read messages:write
User logs in & approves → Thumbtack redirects to your /auth/callback?code=ABC
Your backend POSTs to https://www.thumbtack.com/api/oauth2/token → gets access_token + refresh_token
Encrypt and store tokens 

Thumbtack refresh tokens last 6 months. Refresh automatically when access_token expires (1 hour).
6. Webhook Handling (Critical for Real-Time)
Thumbtack will POST events to your public endpoint. You must:

Expose POST /webhooks/thumbtack
Verify signature (Thumbtack sends X-Thumbtack-Signature header — HMAC-SHA256 with your webhook secret)
Supported events you care about:
request.created
request.message.created
request.status.changed
negotiation.updated


On every webhook → update your DB cache + (optionally) push via Socket.io / Pusher / Firebase to mobile apps.
7. Security & Best Practices

Never expose Thumbtack tokens to frontend
Encrypt refresh tokens at rest
Rate limiting (Thumbtack allows ~5000 requests/hour per pro)
Idempotency keys on message/quote sends
Background job queue (BullMQ / Celery) for sending messages (in case Thumbtack is slow)
Comprehensive logging + error monitoring (Sentry)

8. Recommended Tech Stack (2025)
Option A — Node.js + TypeScript 
textNestJS or Fastify + Prisma + PostgreSQL + BullMQ + Redis
Passport or custom OAuth2 strategy
Deploy: Railway
textFastAPI + SQLModel or Tortoise-ORM + PostgreSQL + Celery + Redis
Deploy: Vercel

9. Deployment & Operations

Domain: api.yourcompany.com (with valid SSL)
Environment variables:
THUMBTACK_CLIENT_ID, THUMBTACK_CLIENT_SECRET,
THUMBTACK_WEBHOOK_SECRET, ENCRYPTION_KEY, DATABASE_URL, etc.
Health check endpoint /health
Monitoring: Prometheus + Grafana or Datadog

10. Future-Proofing for CRM Integration
Because this backend is completely separate:

Your CRM will just call the same API endpoints (add CRM API key auth if needed)
Or embed the React web app via iframe
Or import the OpenAPI spec and generate SDKs inside CRM

Zero code duplication.
Summary – What You Need to Build First (MVP in 2–4 weeks)

OAuth2 connect + token storage (encrypted)
GET /leads + GET /leads/:id
POST /leads/:id/message
Webhook endpoint with signature verification + lead creation/update
Your own JWT auth layer for web/mobile apps

Multiple integrsations preset:
Here’s how to future-proof your backend so you can plug in any new lead/communication platform (Yelp included) with almost zero refactoring.
Final Recommended Architecture (Multi-Platform Ready)
text+------------------+       +---------------------+
|  Web App         |       |  Mobile App (RN)    |
|  (React) CRM        |       |                     |
+------------------+       +---------------------+
         ↓  REST/GraphQL (your own JWT)
+------------------+---------------------------+------------------+
|                Unified API Gateway (v1)                           |
|  /leads, /conversations, /messages, /quotes, /platforms, …       |
+--------+
+---------------------------------------+---------------------------------+
                                          |
                                          ↓
                           +-------------------------------+
                           |      Platform Router          |
                           |  (detects platform from lead  |
                           |   or from user.settings)      |
                           +-------------------------------+
                                 ↓                ↓
                 +-----------------------------+   +------------------------------+
                 |   Thumbtack Adapter           |   |   Yelp Adapter               |
                 |  (implements IPlatform)     |   |  (implements IPlatform)      |
                 +-----------------------------+   +------------------------------+
                                 ↓                                ↓
                 Thumbtack API (OAuth2 + Webhooks)    Yelp API (OAuth2 or API Key + Webhooks)
What You Need to Add/Change Right Now (Very Small)

Create an interface/contract (TypeScript example)

TypeScriptinterface ILeadPlatform {
  // Connection
  getAuthUrl(userId: string): string;
  handleCallback(code: string, userId: string): Promise<void>;
  disconnect(userId: string): Promise<void>;

  // Core actions
  getLeads(userId: string, since?: Date): Promise<NormalizedLead[]>;
  getConversation(threadId: string): Promise<NormalizedMessage[]>;
  sendMessage(threadId: string, text: string): Promise<void>;
  sendQuote(threadId: string, amount: number, note?: string): Promise<void>;

  // Webhook verification
  verifyWebhookSignature(headers: any, body: any): boolean;
  handleWebhookEvent(event: any, userId?: string): Promise<void>;
}

Create a “platforms” table (in addition to the ones I gave you earlier)

SQLplatforms
├── id (uuid)
├── user_id → users.id
├── platform_name ("thumbtack" | "yelp" | "angi"angi" | "bark" | etc.)
├── connected (boolean)
├── external_user_id
├── credentials_json (encrypted — contains access_token, refresh_token, api_key, etc.)
├── webhook_secret (encrypted)
├── last_sync_at
├── metadata_json

Implement one adapter per platform

textsrc/platforms/
├── thumbtack.adapter.ts      ← already done
├── yelp.adapter.ts           ← you will add this next
├── angi.adapter.ts
├── bark.adapter.ts
└── index.ts → factory that returns the right adapter based on platform_name

Normalize the data (this is the magic)

Create one single format your frontend and CRM will ever see:
TypeScripttype NormalizedLead = {
  id: string;
  platform: "thumbtack" | "yelp" | "angi" | ...;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  message: string;
  budget?: number;
  postcode?: string;
  createdAt: Date;
  threadId: string;           // universal conversation ID inside your system
  status: "new" | "contacted" | "quoted" | "booked" | "lost";
  raw: any; // original payload if you ever need it
}
Every adapter converts the platform’s weird JSON into this exact shape.
Example: Adding Yelp in < 1 Week
Yelp has two relevant APIs in 2025:

Yelp Fusion API (public business data + reviews)
Yelp for Business Owners API (leads & messages — this is the one you want)

Steps:

Register at https://www.yelp.com/developers → get Client ID + Secret
Implement YelpAdapter that implements ILeadPlatform
Yelp uses long-lived API key (no OAuth dance in most cases) → store it encrypted
Yelp sends webhooks for “New Message”, “New Request”, etc. → verify with HMAC secret
Map Yelp’s lead → your NormalizedLead
Done — your frontend and CRM instantly see Yelp leads next to Thumbtack ones

Bonus: Unified Inbox in Your App/CRM
Because everything is normalized, you can now build one single inbox screen:
textGET /v1/inbox → returns all conversations from ALL connected platforms, sorted by last_message_at
Your users will love it.
Summary — What You Should Do Right Now
TaskTimeWhyAdd platforms table + platform_name column everywhere2 hoursFuture-proofs DBCreate ILeadPlatform interface + NormalizedLead type2–4 hoursSingle source of truthRefactor Thumbtack code into ThumbtackAdapter1 dayMakes next platforms copy-pasteAdd platform factory (getAdapter(userId, platform))4 hoursCentral routing logic(Later) Add YelpAdapter3–5 daysProves the architecture works
Once you do this, adding any new platform (Google LSA, Houzz, Porch, TaskRabbit, etc.) becomes a repeatable 3–7 day task instead of a 2-month project.
If you want, I can send you a complete GitHub starter repository (Node.js + TypeScript + Prisma) with Thumbtack already implemented as an adapter and a blank Yelp adapter ready to fill in. Just say the word.