# Spec: Follow-Up Engine

## Problem

When a business responds to a lead (via auto-reply or manually) and the customer doesn't reply back, there's no systematic way to follow up. Currently:
- Single delayed message (AutomationRule with `isFollowUp: true`)
- No sequence cadence (can't do 2min → 10min → 1hr → 1day → 3day)
- No state awareness (same follow-up whether customer ghosted after initial reply or after receiving a price quote)
- No suggestion mode (always auto-sends, no human review)
- No visibility into what follow-up is pending or why

## Goal

A **state-driven, sequence-based follow-up engine** that:
1. Reads thread context (stage, summary, state) to determine WHY the customer stopped responding
2. Selects the appropriate follow-up sequence for that scenario
3. Executes steps on a cadence, respecting active hours
4. Stops instantly when customer replies
5. Surfaces suggestions for user review (v1) with future auto-send support
6. Works for Yelp now, Thumbtack later

## Non-Goals

- No visual workflow/sequence builder — presets only
- No branching/conditional steps (v1)
- No A/B testing
- No cross-channel sequences (one platform per sequence)
- No lead-level memory (thread-level only)

---

## Data Model

### 3 new models (not 5 — TransitionRule is context-driven logic, not a table)

#### `FollowUpSequenceTemplate`
Reusable blueprint. Defines a cadence for a scenario.

| Field | Type | Notes |
|-------|------|-------|
| id | cuid | PK |
| userId | string | Owner (tenant-scoped) |
| platform | string | "yelp", "thumbtack", "all" |
| name | string | e.g. "Standard — No Reply After Initial" |
| triggerState | string | Which thread state triggers this: `no_reply_after_initial`, `no_reply_after_question`, `no_reply_after_price`, `no_reply_after_conversion` |
| mode | string | "suggest" (v1) or "auto_send" |
| generationMode | string | "template" or "ai" |
| promptTemplateId | string? | FK MessageTemplate (for AI mode) |
| preset | string? | "conservative", "standard", "persistent" |
| isDefault | boolean | Default for this triggerState+platform |
| activeHoursStart | string? | "09:00" |
| activeHoursEnd | string? | "21:00" |
| activeHoursTimezone | string? | "America/New_York" |
| stepsJson | Json | Array of `{ stepOrder, delayMinutes, objective, messageTemplate? }` |
| enabled | boolean | |
| createdAt, updatedAt | DateTime | |

**`stepsJson` structure** (avoids a separate table for simplicity):
```json
[
  { "stepOrder": 1, "delayMinutes": 2, "objective": "quick_check_in" },
  { "stepOrder": 2, "delayMinutes": 10, "objective": "value_add" },
  { "stepOrder": 3, "delayMinutes": 60, "objective": "soft_nudge" },
  { "stepOrder": 4, "delayMinutes": 1440, "objective": "re_engagement" },
  { "stepOrder": 5, "delayMinutes": 4320, "objective": "last_chance" }
]
```

Each step has an `objective` (not a hardcoded message). AI generates text from objective + thread context. Template mode uses `messageTemplate` field per step.

#### `FollowUpEnrollment`
One active per conversation. Tracks progress through a sequence.

| Field | Type | Notes |
|-------|------|-------|
| id | cuid | PK |
| sequenceTemplateId | string | FK SequenceTemplate |
| conversationId | string | FK Conversation (1:1 active) |
| leadId | string? | FK Lead |
| platform | string | |
| status | string | "active", "paused", "completed", "stopped" |
| stoppedReason | string? | "customer_replied", "manual", "switched", "thread_closed" |
| currentStepIndex | int | 0-based pointer |
| nextStepDueAt | DateTime? | **INDEXED** — scheduler queries this |
| mode | string | "suggest" or "auto_send" (can override template default) |
| startedAt | DateTime | |
| lastExecutedAt | DateTime? | |
| completedAt | DateTime? | |
| createdAt, updatedAt | DateTime | |

**Critical index**: `@@index([status, nextStepDueAt])` — the scheduler's query.

#### `FollowUpStepExecution`
Audit trail per step. What happened and when.

| Field | Type | Notes |
|-------|------|-------|
| id | cuid | PK |
| enrollmentId | string | FK Enrollment |
| stepIndex | int | Which step in the sequence |
| objective | string | "quick_check_in", "value_add", etc. |
| status | string | "scheduled", "suggested", "approved", "sent", "skipped", "cancelled", "failed" |
| scheduledAt | DateTime | When it was supposed to fire |
| executedAt | DateTime? | When it actually fired |
| generatedMessage | string? | AI/template output |
| finalMessage | string? | What was actually sent (may be edited by user) |
| messageId | string? | FK to Message table (if sent) |
| strategyUsed | string? | Which AI strategy was active |
| metadataJson | string? | Delivery status, error info |
| createdAt | DateTime | |

### Cached fields on ThreadContext (already partially exist)

Add/update:
- `activeEnrollmentId` — FK to active FollowUpEnrollment
- `nextFollowUpAt` — denormalized from enrollment.nextStepDueAt
- `waitingSince` — when the business last spoke and customer hasn't replied
- `followUpState` — derived: `no_reply_after_initial`, `no_reply_after_question`, etc.

Existing fields already work:
- `followUpCount` ✅
- `followUpStatus` ✅ (extend values: "none", "active", "suggested", "paused", "completed")
- `lastFollowUpAt` ✅
- `awaitingCustomerReply` ✅

---

## Thread Follow-Up States

Derived from ThreadContext fields (rule-based, not a separate table):

| State | Condition |
|-------|-----------|
| `no_reply_after_initial` | `stage == 'qualification'` AND `awaitingCustomerReply` AND `businessMessages >= 1` AND `customerMessages <= 1` |
| `no_reply_after_question` | `awaitingCustomerReply` AND `lastQuestionAsked != null` |
| `no_reply_after_price` | `awaitingCustomerReply` AND `priceDiscussed` |
| `no_reply_after_conversion` | `stage == 'negotiation'` AND `awaitingCustomerReply` |
| `engaged` | NOT `awaitingCustomerReply` — customer is actively responding |
| `won` | `stage == 'booked'` |
| `lost` | `stage == 'lost'` OR `engagementLevel == 'cold'` |

The engine selects the most specific matching state (priority: conversion > price > question > initial).

---

## Sequence Presets

Three presets per trigger state, pre-seeded:

### Conservative (3 steps, gentle)
```
Step 1: 1 hour — quick_check_in
Step 2: 1 day — value_add
Step 3: 3 days — soft_close
```

### Standard (5 steps, balanced)
```
Step 1: 2 minutes — quick_check_in
Step 2: 10 minutes — value_add
Step 3: 1 hour — soft_nudge
Step 4: 1 day — re_engagement
Step 5: 3 days — last_chance
```

### Persistent (8 steps, aggressive)
```
Step 1: 2 minutes — quick_check_in
Step 2: 10 minutes — value_add
Step 3: 1 hour — soft_nudge
Step 4: 1 day — re_engagement
Step 5: 3 days — last_chance
Step 6: 7 days — monthly_check
Step 7: 14 days — monthly_check
Step 8: 30 days — final_attempt
```

Step objectives drive AI generation. Each objective maps to a generation strategy (defined in the FollowUpEngine, not in the template).

---

## Engine Flow

### 1. Enrollment (triggered by context state change)

```
Message arrives → recordMessage() updates ThreadContext
    → ThreadContext.awaitingCustomerReply becomes true
    → FollowUpEngine.evaluateThread(conversationId)
        → Derive followUpState from ThreadContext fields
        → If no active enrollment for this state:
            → Find matching SequenceTemplate (triggerState + platform + enabled)
            → Create FollowUpEnrollment
            → Compute nextStepDueAt for step 0 (respecting active hours)
            → Update ThreadContext cached fields
```

### 2. Execution (cron every 60s)

```
Cron fires → SELECT * FROM follow_up_enrollments
             WHERE status = 'active' AND nextStepDueAt <= NOW()
    → For each enrollment:
        → Load ThreadContext (quick state read)
        → Verify thread still eligible (customer hasn't replied, not closed)
        → Load current step from stepsJson
        → If mode == 'suggest':
            → Generate message (AI or template)
            → Create StepExecution with status = 'suggested'
            → Emit SSE notification to user
        → If mode == 'auto_send':
            → Generate message
            → Send via platform adapter
            → Create StepExecution with status = 'sent'
            → Record in ThreadContext via recordMessage()
        → Advance: currentStepIndex++, compute next nextStepDueAt
        → If no more steps: status = 'completed'
```

### 3. Stop on Customer Reply (synchronous)

```
Customer message arrives → webhook handler
    → Before automation triggers:
        → FollowUpEngine.handleCustomerReply(conversationId)
            → Find active enrollment
            → Set status = 'stopped', stoppedReason = 'customer_replied'
            → Cancel any pending StepExecution
            → Clear ThreadContext cached fields
```

### 4. Sequence Switching

```
ThreadContext.stage changes (via updateState or manual)
    → FollowUpEngine.evaluateThread(conversationId)
        → New followUpState differs from current enrollment's triggerState
        → Stop current enrollment (stoppedReason = 'switched')
        → Enroll in new sequence matching new state
```

---

## Active Hours

Computed at step advancement, NOT at send time:

```
rawDueAt = lastExecutedAt + step.delayMinutes
localTime = rawDueAt in enrollment timezone
if localTime within [activeHoursStart, activeHoursEnd]:
    nextStepDueAt = rawDueAt
else:
    nextStepDueAt = next activeHoursStart in enrollment timezone
```

This means the scheduler only queries `WHERE nextStepDueAt <= NOW()` — no timezone math at runtime.

---

## UI

### Services Page — "Yelp Follow-ups" card (existing, refactored)

**Keep existing familiar elements:**
- Active Hours (start, end, timezone)
- Template / AI toggle
- Prompt template selector

**Add:**
- Follow-up Mode dropdown: Off / Suggest / Auto-send
- Preset selector: Conservative / Standard / Persistent
- Scenario dropdown: After initial reply / After question / After price / After conversion step

**Remove:**
- Single "delay after lead" input (replaced by sequence cadence)

### Lead Activity Panel — Per-thread visibility

Show in lead detail:
- Current follow-up state: "Waiting for customer after quote"
- Active sequence: "Standard Yelp follow-up"
- Next follow-up: "Suggested in 1 hour" or "Auto-sends in 1 hour"
- Actions: Send Now / Edit / Skip / Pause / Cancel

### Suggestion notifications

When a step fires in suggest mode:
- SSE event to frontend
- Badge/indicator on the lead in the list
- Expandable suggestion card in lead activity

---

## Migration

1. Existing `AutomationRule` with `isFollowUp: true` → map to single-step SequenceTemplate
2. Preserve: activeHoursStart/End/Timezone, delayMinutes, useAi, promptTemplateId
3. Create enrollment for any conversation that has an active follow-up pending
4. No breaking changes — old rules continue to work during migration
5. Frontend progressively adopts new UI

---

## Acceptance Criteria

1. ✅ Existing Yelp follow-up settings preserved and mapped into new system
2. ✅ Follow-ups driven by conversation/thread context (state-derived)
3. ✅ Different no-reply scenarios trigger different sequences
4. ✅ Active hours and timezone respected (computed at step advancement)
5. ✅ Sequences stop instantly when customer replies (synchronous)
6. ✅ Suggestion mode works — step fires, creates suggestion, user reviews
7. ✅ Thread UI shows follow-up status, next step, state
8. ✅ Architecture reusable for Thumbtack (platform field on templates)
9. ✅ Context system is source of truth, follow-up engine is separate consumer

---

## Implementation Phases

### Phase 1: DB + Module + Scheduler
- 3 Prisma models + migration
- FollowUpEngineModule (service + controller + scheduler)
- Cron job skeleton
- Seed preset sequences

### Phase 2: Enrollment + Execution + Stop
- evaluateThread() — derive state, enroll in sequence
- Scheduler executes due steps (suggestion mode)
- handleCustomerReply() — stop enrollment
- Wire into webhook handlers

### Phase 3: AI Generation + Strategy + UI
- Generate messages from objective + ThreadContext
- Strategy integration (activeStrategy → generation style)
- Lead activity panel: follow-up status + suggestion card
- Services page: preset selector, mode dropdown

### Phase 4: Settings UI + Migration + Extensibility
- Map existing AutomationRule follow-ups to new model
- Scenario-based configuration UI
- Platform-agnostic layer for Thumbtack
