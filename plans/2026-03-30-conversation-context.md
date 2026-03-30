# Plan: Conversation Context System

## Architecture Decision

**Dedicated `conversation-context` module** — owns all thread intelligence.
Does NOT scatter fields across existing models. Instead:

- **Reads from** existing `Conversation` + `Message` tables (operational data)
- **Writes to** its own `ThreadContext` table (intelligence layer)
- Clean interface boundary: input = conversationId, output = context object
- Extractable to separate "Behavior IQ" service later

```
┌─────────────────────────────────────────┐
│  Existing Operational Layer             │
│  Conversation, Message, Lead            │
│  (owned by webhooks/leads/platforms)    │
└──────────────┬──────────────────────────┘
               │ reads
┌──────────────▼──────────────────────────┐
│  conversation-context module            │
│  ┌─────────────────────────────────┐    │
│  │ ThreadContext (own table)        │    │
│  │ - summary, stateJson            │    │
│  │ - stage, strategies             │    │
│  │ - follow-up tracking            │    │
│  │ - timestamps per sender type    │    │
│  └─────────────────────────────────┘    │
│  ┌─────────────────────────────────┐    │
│  │ ConversationContextService      │    │
│  │ - buildContext(conversationId)   │    │
│  │ - updateSummary()               │    │
│  │ - updateState()                 │    │
│  │ - recordMessage()               │    │
│  └─────────────────────────────────┘    │
│  ┌─────────────────────────────────┐    │
│  │ ConversationContextController   │    │
│  │ - GET /context/:conversationId  │    │
│  │ - GET /context/:id/timeline     │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
               │ consumed by
┌──────────────▼──────────────────────────┐
│  AI Service, Automation Service         │
│  (uses context instead of raw history)  │
└─────────────────────────────────────────┘
```

## Phase 1: Schema + Module Scaffold

### New Prisma model: ThreadContext
- `id` (PK)
- `conversationId` (FK Conversation, unique — 1:1)
- `leadId` (FK Lead, nullable — for quick lead-level queries)
- `platform` (denormalized for query efficiency)
- `stage` — qualification, quoting, negotiation, booked, lost, closed
- `customerIntent` — price_shopping, ready_to_book, just_browsing, urgent
- `engagementLevel` — cold, warm, hot
- `activeStrategy` — current strategy name
- `suggestedStrategy` — AI-suggested next
- `summary` (Text) — rolling AI-friendly summary
- `stateJson` (Text) — full structured state
- `priceDiscussed` (Boolean)
- `priceRange` — e.g. "$120-$180"
- `lastQuestionAsked` — last question from business
- `missingFields` (JSON) — array of field names
- `followUpCount` (Int)
- `lastFollowUpAt` (DateTime)
- `awaitingCustomerReply` (Boolean)
- `lastCustomerMessageAt` (DateTime)
- `lastBusinessMessageAt` (DateTime)
- `lastAiMessageAt` (DateTime)
- Timestamps

### New NestJS module: ConversationContextModule
- `conversation-context.module.ts`
- `conversation-context.service.ts`
- `conversation-context.controller.ts`

### Phase 1 scope:
1. Prisma migration for ThreadContext
2. Module scaffold (service + controller)
3. `recordMessage()` — called after webhook stores a message, creates/updates ThreadContext
4. `getContext()` — returns full context for a conversation
5. Wire into webhook handler (after message stored → recordMessage)

## Phase 2: Context Builder + Updaters
- `buildContext()` — assembles AI-ready context from ThreadContext + recent messages
- `updateSummary()` — AI call to compress thread
- `updateState()` — rule-based state extraction

## Phase 3: AI Integration + Debug
- Replace raw history in automation with buildContext()
- Debug endpoint + admin panel visibility
