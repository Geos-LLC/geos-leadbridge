
---

**Task: Implement Conversation Context System for LeadBridge**

Build a conversation context system for LeadBridge so AI responses, strategy suggestions, and future follow-ups work per conversation thread without losing context.

### Goal

The system must preserve context for each individual conversation thread, even when one lead has multiple separate conversations. AI should be able to continue a specific thread with awareness of:

* prior messages
* what was already asked
* what pricing was mentioned
* current conversation stage
* missing information
* active/suggested strategy
* follow-up history

---

## Scope

### 1. Add per-thread conversation memory

For each conversation thread, store:

#### A. Full message history

Each message should include at least:

* `id`
* `threadId`
* `leadId`
* `platform` (`yelp`, later other sources)
* `direction` (`incoming`, `outgoing`, `system`)
* `senderType` (`customer`, `business`, `ai`, `user`, `system`)
* `body`
* `createdAt`
* optional metadata:

  * `isAutoFollowUp`
  * `strategyUsed`
  * `aiGenerated`
  * `deliveryStatus`

#### B. Rolling thread summary

Store a short AI-friendly summary of the conversation thread, updated over time.

Example:

* customer intent
* service requested
* price range already discussed
* unanswered question
* current next step

#### C. Structured conversation state

Store machine-readable state for each thread, for example:

```json
{
  "stage": "qualification",
  "customerIntent": "price_shopping",
  "engagementLevel": "medium",
  "activeStrategy": "hybrid",
  "suggestedStrategy": "price_anchor",
  "priceDiscussed": true,
  "priceRangeShared": "$120-$180",
  "phoneRequested": false,
  "phoneProvided": false,
  "lastQuestionAsked": "How many bedrooms and bathrooms?",
  "missingFields": ["bedrooms", "bathrooms", "cleaning_type"],
  "followUpCount": 1,
  "lastFollowUpType": "clarification",
  "awaitingCustomerReply": true
}
```

This can be stored as JSON for now.

---

## 2. Data model changes

### Add / update entities

#### `conversation_threads`

Suggested fields:

* `id`
* `leadId`
* `platform`
* `externalThreadId`
* `status` (`active`, `closed`, `archived`)
* `activeStrategy`
* `suggestedStrategy`
* `summary`
* `stateJson`
* `lastMessageAt`
* `lastCustomerMessageAt`
* `lastBusinessMessageAt`
* `lastAiMessageAt`
* `followUpStatus`
* `createdAt`
* `updatedAt`

#### `conversation_messages`

Suggested fields:

* `id`
* `threadId`
* `leadId`
* `platform`
* `externalMessageId`
* `direction`
* `senderType`
* `body`
* `metadataJson`
* `createdAt`

Optional later:

* `ai_prompt`
* `ai_response`
* `ai_model`
* `tokens_used`

---

## 3. Context builder service

Create a service that prepares AI context for a specific thread.

### Input

* `threadId`

### Output

A context object for prompt generation:

* thread summary
* structured state
* recent messages
* lead-level facts if available
* active strategy
* follow-up history

### Rules

* Always load context by `threadId`, not just `leadId`
* Use the thread summary + structured state as primary memory
* Include recent messages from the same thread
* Do not mix messages from other threads unless explicitly requested as lead-level memory

---

## 4. Summary updater

Create a mechanism to keep the thread summary updated.

### v1 acceptable options

* update summary after every new message
* or update every N messages
* or update only when AI sends/responds

### Requirements

The summary should stay short, practical, and useful for next-step generation.

It should capture:

* customer goal
* important facts already provided
* pricing status
* objections / uncertainty
* current unanswered question
* current stage

---

## 5. Structured state updater

Create logic that updates `stateJson` whenever a message is added or AI responds.

At minimum update:

* `stage`
* `activeStrategy`
* `suggestedStrategy`
* `priceDiscussed`
* `priceRangeShared`
* `lastQuestionAsked`
* `missingFields`
* `followUpCount`
* `awaitingCustomerReply`
* `engagementLevel`

For v1 this can be rule-based, not full AI extraction.

---

## 6. Thread-first behavior

Make sure the system treats each conversation independently.

### Important

If one lead has multiple threads:

* each thread must keep its own history
* each thread must have its own summary
* each thread must have its own state

Do not rely only on lead-level memory.

Lead-level memory can be added later as a separate optional layer.

---

## 7. API / service layer

Add functions/endpoints for:

* get thread context
* append message to thread
* update thread summary
* update thread state
* fetch recent messages for AI prompt
* fetch thread timeline for UI/debugging

---

## 8. UI / internal visibility

For debugging and future product use, expose thread context in admin/dev tools:

* active strategy
* suggested strategy
* current stage
* summary
* state JSON
* follow-up count
* awaiting reply flag

No need for polished UI yet; internal visibility is enough.

---

## 9. Future compatibility

Design this so it works later for:

* strategy suggestion engine
* automatic follow-ups
* human takeover
* multi-channel threads
* lead-level memory
* analytics on conversion by strategy

---

## 10. Acceptance criteria

Implementation is complete when:

1. Every thread has isolated message history
2. Every thread stores rolling summary
3. Every thread stores structured state JSON
4. AI context is built from thread-level memory
5. Multiple threads under the same lead do not overwrite each other’s context
6. Follow-up logic can read the thread state without parsing the full transcript every time
7. New messages update thread memory correctly

---

## Suggested implementation order

### Phase 1

* create DB entities / migrations
* store message history per thread
* store summary + stateJson on thread

### Phase 2

* build context builder service
* build summary updater
* build state updater

### Phase 3

* connect AI response generation to thread context
* expose thread context for internal debugging

---

## Notes for implementation

* Keep the system simple and extensible
* Prefer thread-level memory first
* Use rolling summary + state JSON to avoid sending full transcript every time
* Do not overengineer lead-level shared memory yet

---

