
**Task: Refactor and Extend LeadBridge Follow-Up System into a Reusable Conversation Follow-Up Engine**

We already have a basic Yelp follow-up feature in LeadBridge with:

* active hours
* timezone
* delay after lead
* follow-up type (`Template` / `AI Follow-up`)
* AI prompt template selection
* manual creation of a follow-up

Current UI example:

* Yelp Follow-ups
* Active Hours
* Follow-up Type
* Delay after lead
* AI Prompt Template
* Create Follow-up

This existing functionality should **not be discarded**. Instead, refactor it into a more complete and reusable **Follow-Up Engine** that works with the new **conversation context system** and can later support both **Yelp and Thumbtack**.

---

## Main Goal

Build a follow-up engine that:

* uses the existing conversation context/thread memory
* supports follow-up sequences, not just one-off delayed follow-ups
* works per conversation thread
* can suggest follow-ups first, then later support automatic sending
* reuses and extends the current Yelp follow-up settings instead of replacing them
* is architected as a reusable module that can later power Thumbtack follow-ups too

---

# 1. Architecture

## Keep the existing conversation context system as the source of truth

The context system already / will store:

* message history
* summary
* stateJson
* activeStrategy / suggestedStrategy
* thread-level memory

Follow-ups must **consume** this context, not create a separate memory model.

## Add a separate Follow-Up Engine module

Implement follow-ups as a separate module/service layer on top of the context system.

Suggested module responsibilities:

* determine whether a thread is eligible for follow-up
* identify which follow-up scenario the thread is in
* attach the correct follow-up sequence
* schedule next follow-up step
* generate suggested or automatic follow-up text
* cancel / pause / switch sequence when customer replies
* track follow-up history and progress

Suggested services:

* `FollowUpEngineService`
* `FollowUpSequenceService`
* `FollowUpSchedulerService`
* `FollowUpSuggestionService`
* `FollowUpRulesService`

Do not bury this logic inside generic conversation services.

---

# 2. Reuse Existing Yelp Follow-Up Functionality

We already have:

* active hours
* timezone
* delay after lead
* follow-up type
* AI prompt template
* “create follow-up”

This should become the **first configuration layer** of the new system.

## Existing fields/settings should map into the new engine:

* **Active Hours** → execution window rules for follow-up scheduling
* **Timezone** → schedule evaluation timezone
* **Follow-up Type**

  * `Template` = fixed follow-up generation mode
  * `AI Follow-up` = AI-generated follow-up mode
* **Delay after lead** → initial sequence timing / initial trigger timing
* **AI Prompt Template** → strategy template / prompt profile for follow-up generation
* **Create Follow-up** → becomes create sequence / create rule / create follow-up plan depending on UI

Do not remove these concepts. Normalize them into the new model.

---

# 3. Follow-Up Engine Model

## Follow-up should be based on thread state, not just “delay after lead”

The engine should understand the difference between scenarios such as:

### A. No reply after first business response

Example:

* customer inquired
* business/AI replied
* customer never answered

### B. No reply after business asked a clarifying question

Example:

* customer engaged
* business asked for details
* customer stopped replying

### C. No reply after price / quote range shared

Example:

* price range shared
* customer disappeared

### D. No reply after conversion step

Example:

* business offered to book / call / continue
* customer did not answer

These should become internal follow-up states / triggers.

---

# 4. Data Model

Add proper reusable follow-up entities/tables rather than storing everything only on Conversation.

## A. `follow_up_sequence_templates`

Reusable sequence definitions.

Suggested fields:

* `id`
* `platform` (`yelp`, later `thumbtack`, etc.)
* `name`
* `description`
* `triggerState`
* `mode` (`template`, `ai`)
* `isDefault`
* `configJson`
* `createdAt`
* `updatedAt`

Examples:

* `yelp_no_reply_after_initial`
* `yelp_no_reply_after_question`
* `yelp_no_reply_after_price`
* `yelp_no_reply_after_conversion`

---

## B. `follow_up_sequence_runs`

Represents an active sequence attached to a specific thread.

Suggested fields:

* `id`
* `threadId`
* `leadId`
* `platform`
* `templateId`
* `status` (`active`, `paused`, `completed`, `canceled`, `stopped`)
* `currentStepIndex`
* `startedAt`
* `lastExecutedAt`
* `nextExecutionAt`
* `stoppedAt`
* `stopReason`
* `contextSnapshotJson`
* `createdAt`
* `updatedAt`

---

## C. `follow_up_events`

History/audit per step execution.

Suggested fields:

* `id`
* `threadId`
* `sequenceRunId`
* `stepIndex`
* `scheduledAt`
* `executedAt`
* `status` (`scheduled`, `suggested`, `sent`, `skipped`, `canceled`, `failed`)
* `generationMode` (`template`, `ai`)
* `generatedMessage`
* `finalMessage`
* `messageId`
* `metadataJson`
* `createdAt`

---

## D. Cached fields on `Conversation` / thread entity

It is okay to keep lightweight cached fields there for UI and querying:

* `followUpStatus`
* `followUpCount`
* `activeSequenceId`
* `nextFollowUpAt`
* `waitingSince`
* `followUpPaused`
* `followUpStoppedReason`

But the real engine state should live in dedicated follow-up models.

---

# 5. Sequence Logic

## Support sequence-based cadence

A follow-up should not be only one delay after lead. Support sequences such as:

Example standard sequence:

* 2 minutes
* 10 minutes
* 1 hour
* 1 day
* 3 days
* 7 days
* 14 days
* 30 days
* monthly up to 12 months

The actual cadence should be template-driven.

## Active hours must be respected

If a step is due outside active hours:

* do not execute immediately
* move it to the next allowed active period

## Stop conditions

Sequence should stop when:

* customer replies
* thread is marked closed / won / lost
* business pauses follow-ups
* business manually cancels sequence

## Switch conditions

If customer replies and business sends a new message that opens a new unresolved state:

* old sequence should close
* a new appropriate sequence may begin

This is critical.

---

# 6. Follow-Up Generation

## Support both existing modes

### Template mode

Use predefined message templates / objectives.

### AI mode

Generate follow-up using:

* conversation summary
* stateJson
* recent messages
* active strategy
* follow-up scenario

## Important

Do not store only final text for each step.
Store a structured step objective when possible, for example:

* clarification
* value-add
* price continuation
* soft conversion
* re-engagement

Then generate actual text from context.

---

# 7. Strategy Integration

We already have strategy work planned:

* global strategy
* template strategies
* suggested strategy
* later auto strategy

Follow-up generation must integrate with strategy system.

Examples:

* if active strategy is `hybrid`, follow-up should use hybrid style
* if state is price-focused, price-anchor strategy may be suggested
* user can later override suggested strategy per thread

Support:

* `activeStrategy`
* `suggestedStrategy`
* `strategyUsed` per follow-up event

---

# 8. UI / UX Requirements

We already split user flow into:

* **Alerts**
* **Client Communication**
* **Follow Ups**

Keep this split.

## A. Alerts

Should remain for:

* lead notifications
* first response / immediate automation

Do not overload this section with full sequence settings.

## B. Client Communication

Should remain for:

* texting/calling after phone is available
* direct customer communication tools

## C. Follow Ups

This should become the home for post-reply conversation continuation.

---

## Follow Ups settings page

Refactor existing Yelp Follow-ups UI into a cleaner engine-based structure.

### Keep familiar existing elements:

* Active Hours
* Timezone
* Follow-up Type
* AI Prompt Template

### Add:

* Follow-up Mode:

  * Off
  * Suggest follow-ups
  * Send automatically

For v1, suggestion mode can remain the primary path.

### Add preset sequence packs:

* Conservative
* Standard
* Persistent

### Add scenario-based configuration:

* After first reply with no answer
* After unanswered clarifying question
* After price/quote sent
* After conversion step

Do not make the UI overly technical. Use simple labels.

---

## Per-thread UI / lead detail panel

In each conversation thread, show:

* current follow-up status
* current state in simple business language
* active sequence
* next follow-up time
* whether it is suggested or automatic
* strategy being used

Example display:

* “Waiting for customer after quote”
* “Standard Yelp follow-up plan active”
* “Next suggested follow-up in 1 hour”

Actions:

* Send now
* Edit suggestion
* Skip
* Pause follow-ups
* Change sequence
* Mark closed

This should be available in the lead detail thread panel / debug panel.

---

# 9. Suggested v1 State Model

Create internal thread states for follow-up triggering:

* `awaiting_customer_after_initial_reply`
* `awaiting_customer_after_clarification`
* `awaiting_customer_after_price`
* `awaiting_customer_after_conversion_step`
* `won`
* `lost`
* `archived`
* `do_not_follow_up`

These can be derived from conversation context/stateJson.

---

# 10. Scheduler Behavior

Implement scheduler logic that periodically checks active sequence runs and determines:

* which follow-up events are due
* whether active hours allow execution
* whether thread state still allows follow-up
* whether to create suggestion or send automatically

For v1:

* suggestion creation is enough if auto-send is not fully enabled yet
* but structure the scheduler so auto-send can be enabled later without rewrite

---

# 11. Platform Extensibility

Do not hardcode Yelp-only logic deep in the engine.

Design:

* shared follow-up engine core
* platform-specific rules / templates / defaults

### Yelp adapter/rules

* initial templates
* active hours defaults
* prompt rules

### Later Thumbtack adapter/rules

* different defaults
* different templates
* potentially more aggressive cadence

The engine should support both.

---

# 12. Migration Path from Existing Functionality

Important: do not break the current feature abruptly.

Migration plan:

1. Keep existing Yelp follow-up settings visible
2. Map them into the new sequence/template model
3. Preserve current behavior for users with existing settings
4. Add richer sequence support on top
5. Gradually refactor frontend labels to match new architecture

Backward compatibility matters.

---

# 13. Acceptance Criteria

Implementation is complete when:

1. Existing Yelp follow-up configuration is preserved and mapped into the new system
2. Follow-ups are driven by conversation/thread context
3. Different no-reply scenarios trigger different follow-up sequences
4. Active hours and timezone are respected
5. Sequence runs stop when customer replies
6. Suggestion mode works per scheduled step
7. Thread UI shows active follow-up status and next step
8. Architecture is reusable for Thumbtack later
9. Context system remains the source of truth, follow-up engine is separate

---

# 14. Suggested Implementation Order

## Phase 1

* add follow-up tables/entities
* wire cached thread-level follow-up fields
* map existing Yelp follow-up settings to new engine config

## Phase 2

* implement follow-up trigger states from context system
* implement sequence template + sequence run logic
* implement scheduler respecting active hours/timezone

## Phase 3

* implement suggestion generation using template/AI mode
* connect to strategy system
* show follow-up info in thread UI

## Phase 4

* refine settings UI for presets and scenario-based configuration
* prepare platform-agnostic layer for Thumbtack reuse

---

## Final note for implementation

Do not treat follow-ups as only “delay after lead.”
Treat them as **state-driven conversation continuation** using the thread context system we already added.

The current Yelp Follow-ups feature should become the starting point and configuration shell for this more powerful engine, not be removed.


