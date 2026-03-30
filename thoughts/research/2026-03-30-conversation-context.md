# Research: Conversation Context System

## Existing Architecture

### Models that exist:
- **Conversation** — universal thread container (platform, externalThreadId, lastMessageAt, status, unreadCount)
- **Message** — individual messages (conversationId, sender: pro|customer|system, content, sentAt)
- **Lead** — links to Conversation via threadId (nullable, one-to-one)
- **LeadConversation** — BYO phone (OpenPhone) conversations matched to leads
- **LeadSmsMessage** — individual SMS messages in BYO conversations

### What's already tracked:
- Full message history (platform + SMS)
- Lead status: new, contacted, quoted, booked, lost
- Conversation status: active, archived, closed
- Unread count, lastMessageAt
- Lead details in rawJson (structured form data)

### What's NOT tracked (gaps):
- No rolling summary per thread
- No structured state JSON (stage, strategy, missing fields)
- No conversation stage tracking
- No follow-up history or count at thread level
- No price discussion tracking
- No "awaiting customer reply" flag

### How AI currently gets context:
- `executePendingMessage` loads ALL messages from conversation
- Builds `conversationHistory: [{role, content}]` array
- Passes raw history + lead details to `aiService.generateReply`
- No summary compression — full transcript every time
- Scales poorly with long conversations

### Key design constraints:
- Conversation model is shared across Thumbtack, Yelp, SMS
- Multiple leads can link to same conversation
- LeadConversation is separate (BYO phone only)
- AI service uses OpenAI with 200 max_tokens response

## Recommendation

**Extend existing Conversation model** rather than creating new tables:
1. Add `summary`, `stateJson`, timestamp fields to existing `Conversation` model
2. Create new `ConversationMessage` model only if existing `Message` model lacks needed fields (it doesn't — it already has sender, content, sentAt, metadata)
3. Build context builder service that reads Conversation + Messages
4. Build summary/state updater that runs after message storage

**Why not new tables**: The existing `Conversation` + `Message` models already have the structure. Adding parallel `conversation_threads` + `conversation_messages` would duplicate data and require syncing. Instead, enrich what exists.
