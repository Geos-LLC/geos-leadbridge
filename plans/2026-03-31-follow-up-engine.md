# Plan: Follow-Up Engine

## Guardrails (from user)

1. stepsJson versioned (`schemaVersion` field) so templates can evolve
2. StepExecution stores both `objective` AND `finalMessage` for audit
3. `activeEnrollmentId`, `nextFollowUpAt`, `followUpStatus` cached on ThreadContext
4. Stop on reply: synchronous + idempotent (check enrollment status before mutating)
5. Suggestion statuses from day one: `suggested`, `approved`, `skipped`, `expired`
6. Active hours rescheduling: explicit day-boundary + timezone-change handling
7. Thread state derivation: isolated in `FollowUpStateService` (Yelp/TT can diverge)
8. Backward compat: existing Yelp follow-up settings map into new model

---

## Module Boundaries

```
src/follow-up-engine/
├── follow-up-engine.module.ts       # NestJS module, imports ConversationContextModule
├── follow-up-engine.service.ts      # Orchestrator: evaluateThread, enrollInSequence, handleCustomerReply
├── follow-up-state.service.ts       # Isolated: derives followUpState from ThreadContext
├── follow-up-scheduler.service.ts   # Cron: finds due enrollments, executes/suggests steps
├── follow-up-generator.service.ts   # Generates message from objective + context (AI or template)
├── follow-up-engine.controller.ts   # REST: approve/skip/pause/cancel, list suggestions
├── follow-up-migration.service.ts   # One-time: maps existing AutomationRule follow-ups
└── index.ts                         # Exports
```

**Dependencies:**
- Reads from: `ConversationContextService` (ThreadContext, buildContext)
- Reads from: `PrismaService` (Message, Conversation, Lead)
- Sends via: `LeadsService.sendMessage()` (platform-agnostic send)
- Notifies: `EventEmitter2` (SSE for suggestion notifications)
- AI: `AiService.generateReply()` (for AI mode)

**Does NOT depend on:** AutomationService, NotificationsService

---

## DB Schema

### 1. FollowUpSequenceTemplate

```prisma
model FollowUpSequenceTemplate {
  id                String   @id @default(cuid())
  userId            String
  platform          String   // "yelp" | "thumbtack" | "all"
  name              String   // "Standard — No Reply After Initial"
  triggerState      String   // "no_reply_after_initial" | "no_reply_after_question" | ...
  mode              String   @default("suggest") // "suggest" | "auto_send"
  generationMode    String   @default("ai") // "ai" | "template"
  promptTemplateId  String?  // FK MessageTemplate (AI mode)
  preset            String?  // "conservative" | "standard" | "persistent"
  isDefault         Boolean  @default(false)
  activeHoursStart  String?  // "09:00"
  activeHoursEnd    String?  // "21:00"
  activeHoursTimezone String? @default("America/New_York")
  stepsJson         Json     // Versioned array of steps
  schemaVersion     Int      @default(1) // For stepsJson evolution
  enabled           Boolean  @default(true)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  user        User @relation(fields: [userId], references: [id], onDelete: Cascade)
  enrollments FollowUpEnrollment[]

  @@index([userId, platform, triggerState])
  @@index([isDefault, platform, triggerState])
  @@map("follow_up_sequence_templates")
}
```

**stepsJson v1 format:**
```json
{
  "schemaVersion": 1,
  "steps": [
    {
      "stepOrder": 0,
      "delayMinutes": 2,
      "objective": "quick_check_in",
      "messageTemplate": null
    }
  ]
}
```

### 2. FollowUpEnrollment

```prisma
model FollowUpEnrollment {
  id                  String    @id @default(cuid())
  sequenceTemplateId  String
  conversationId      String    // FK Conversation
  leadId              String?   // FK Lead
  platform            String
  status              String    @default("active") // "active" | "paused" | "completed" | "stopped"
  stoppedReason       String?   // "customer_replied" | "manual" | "switched" | "thread_closed"
  currentStepIndex    Int       @default(0)
  nextStepDueAt       DateTime? // **CRITICAL INDEX**
  mode                String    @default("suggest") // overrides template default
  startedAt           DateTime  @default(now())
  lastExecutedAt      DateTime?
  completedAt         DateTime?
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt

  sequenceTemplate FollowUpSequenceTemplate @relation(fields: [sequenceTemplateId], references: [id], onDelete: Cascade)
  conversation     Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  lead             Lead? @relation(fields: [leadId], references: [id], onDelete: SetNull)
  stepExecutions   FollowUpStepExecution[]

  @@index([status, nextStepDueAt]) // Scheduler query
  @@index([conversationId, status]) // Active enrollment lookup
  @@index([leadId])
  @@map("follow_up_enrollments")
}
```

### 3. FollowUpStepExecution

```prisma
model FollowUpStepExecution {
  id                String    @id @default(cuid())
  enrollmentId      String
  stepIndex         Int
  objective         String    // "quick_check_in", "value_add", etc.
  status            String    @default("scheduled") // "scheduled" | "suggested" | "approved" | "sent" | "skipped" | "cancelled" | "failed" | "expired"
  scheduledAt       DateTime
  executedAt        DateTime?
  generatedMessage  String?   @db.Text // AI/template output
  finalMessage      String?   @db.Text // What was actually sent (may differ if user edited)
  messageId         String?   // FK Message (if sent to platform)
  strategyUsed      String?   // Active AI strategy at generation time
  metadataJson      String?   @db.Text // Delivery status, error info
  createdAt         DateTime  @default(now())

  enrollment FollowUpEnrollment @relation(fields: [enrollmentId], references: [id], onDelete: Cascade)

  @@index([enrollmentId, stepIndex])
  @@index([status])
  @@map("follow_up_step_executions")
}
```

### 4. ThreadContext additions

```prisma
// Add to existing ThreadContext model:
activeEnrollmentId  String?   // FK FollowUpEnrollment (cached)
nextFollowUpAt      DateTime? // Denormalized from enrollment.nextStepDueAt
waitingSince        DateTime? // When business last spoke, customer hasn't replied
followUpState       String?   // Derived: "no_reply_after_initial", etc.
```

Update existing:
- `followUpStatus`: expand to "none" | "active" | "suggested" | "paused" | "completed" | "stopped"

---

## State Derivation Rules (FollowUpStateService)

Isolated in one service. Returns a single `followUpState` string from ThreadContext.

```typescript
deriveFollowUpState(ctx: ThreadContext): string | null {
  // Not eligible
  if (!ctx.awaitingCustomerReply) return null;   // customer is talking
  if (ctx.stage === 'booked') return null;        // won
  if (ctx.stage === 'lost') return null;           // lost
  if (ctx.stage === 'closed') return null;         // archived
  if (ctx.engagementLevel === 'cold') return null; // gave up

  // Priority order: most specific first
  if (ctx.stage === 'negotiation')
    return 'no_reply_after_conversion';

  if (ctx.priceDiscussed)
    return 'no_reply_after_price';

  if (ctx.lastQuestionAsked)
    return 'no_reply_after_question';

  if (ctx.businessMessages >= 1 || ctx.aiMessages >= 1)
    return 'no_reply_after_initial';

  return null; // No business response yet — nothing to follow up on
}
```

**Platform isolation**: This is `deriveFollowUpState()` in FollowUpStateService. Override for Thumbtack by passing platform-specific rules if needed. Currently single method, easy to split.

---

## Scheduler Flow (FollowUpSchedulerService)

```
@Cron('*/60 * * * * *') // Every 60 seconds
async processFollowUps():
  enrollments = SELECT * FROM follow_up_enrollments
                WHERE status = 'active'
                AND nextStepDueAt <= NOW()
                LIMIT 20  // Batch size

  for each enrollment:
    // Idempotency: re-check status (may have been stopped between query and here)
    fresh = findById(enrollment.id)
    if fresh.status !== 'active': skip

    // Load thread state for eligibility check
    threadState = conversationContext.getThreadState(enrollment.conversationId)
    if !threadState || !threadState.awaitingCustomerReply:
      stopEnrollment(enrollment.id, 'customer_replied')
      continue

    // Load step definition
    template = findById(enrollment.sequenceTemplateId)
    steps = template.stepsJson.steps
    step = steps[enrollment.currentStepIndex]
    if !step:
      completeEnrollment(enrollment.id)
      continue

    // Execute step
    if enrollment.mode === 'suggest':
      message = generateMessage(step, enrollment, threadState)
      createStepExecution(enrollment, step, 'suggested', message)
      emitSuggestionSSE(enrollment.conversationId, message)
    else: // auto_send
      message = generateMessage(step, enrollment, threadState)
      sentMessageId = sendMessage(enrollment, message)
      createStepExecution(enrollment, step, 'sent', message, sentMessageId)

    // Advance to next step
    nextStep = steps[enrollment.currentStepIndex + 1]
    if nextStep:
      nextDue = computeNextDueAt(now, nextStep.delayMinutes, template)
      updateEnrollment(enrollment.id, {
        currentStepIndex: currentStepIndex + 1,
        nextStepDueAt: nextDue,
        lastExecutedAt: now
      })
    else:
      completeEnrollment(enrollment.id)
```

---

## Active Hours — Day Boundary + Timezone Handling

```typescript
computeNextDueAt(
  fromTime: Date,
  delayMinutes: number,
  activeStart: string,   // "09:00"
  activeEnd: string,     // "21:00"
  timezone: string       // "America/New_York"
): Date {
  const rawDue = new Date(fromTime.getTime() + delayMinutes * 60_000);

  // No active hours configured → use raw time
  if (!activeStart || !activeEnd) return rawDue;

  // Convert rawDue to local time in target timezone
  const localHM = getLocalHHMM(rawDue, timezone); // "14:30"
  const [startH, startM] = activeStart.split(':').map(Number);
  const [endH, endM] = activeEnd.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  const localMinutes = localHM hours * 60 + minutes;

  // Within window → use as-is
  if (isWithinWindow(localMinutes, startMinutes, endMinutes)) return rawDue;

  // Before window → snap to today's start
  // After window → snap to tomorrow's start
  // Handle overnight windows (e.g., 22:00-06:00) correctly
  return snapToNextWindowOpening(rawDue, activeStart, timezone);
}

// snapToNextWindowOpening:
// 1. Get current date in timezone
// 2. Set time to activeHoursStart
// 3. If that's in the past, add 1 day
// 4. Convert back to UTC
// This correctly handles DST transitions and day boundaries
```

**Timezone change handling**: If the user changes their timezone setting on a template, existing enrollments keep their computed `nextStepDueAt`. Only NEW step advancements use the updated timezone. No retroactive recomputation.

---

## Stop on Reply — Idempotent

```typescript
async handleCustomerReply(conversationId: string): Promise<void> {
  // Atomic: find active enrollment and stop it in one query
  const result = await prisma.followUpEnrollment.updateMany({
    where: {
      conversationId,
      status: 'active', // Only stop if currently active (idempotent)
    },
    data: {
      status: 'stopped',
      stoppedReason: 'customer_replied',
      completedAt: new Date(),
    },
  });

  if (result.count > 0) {
    // Cancel any pending/suggested step executions
    await prisma.followUpStepExecution.updateMany({
      where: {
        enrollment: { conversationId, status: 'stopped' },
        status: { in: ['scheduled', 'suggested'] },
      },
      data: { status: 'cancelled' },
    });

    // Clear ThreadContext cached fields
    await prisma.threadContext.updateMany({
      where: { conversationId },
      data: {
        activeEnrollmentId: null,
        nextFollowUpAt: null,
        followUpStatus: 'stopped',
        followUpState: null,
      },
    });
  }
  // If result.count === 0 → already stopped or no enrollment → idempotent ✅
}
```

Called from: `webhooks.service.ts` handleMessageCreated (TT) and handleYelpNewEvent (Yelp), BEFORE automation triggers.

---

## Migration: Existing Yelp Follow-ups → New Model

```typescript
// FollowUpMigrationService.migrateExistingFollowUps()

// 1. Find all AutomationRule with isFollowUp = true
const existingRules = await prisma.automationRule.findMany({
  where: { isFollowUp: true },
  include: { savedAccount: true, template: true, promptTemplate: true },
});

for (const rule of existingRules) {
  // 2. Create SequenceTemplate (single-step sequence)
  const template = await prisma.followUpSequenceTemplate.create({
    data: {
      userId: rule.userId,
      platform: rule.savedAccount?.platform || 'yelp',
      name: rule.name || `Migrated Follow-up (${rule.delayMinutes}m)`,
      triggerState: 'no_reply_after_initial', // Default for migrated rules
      mode: 'auto_send', // Existing behavior was auto-send
      generationMode: rule.useAi ? 'ai' : 'template',
      promptTemplateId: rule.promptTemplateId,
      preset: null,
      isDefault: false,
      activeHoursStart: rule.activeHoursStart,
      activeHoursEnd: rule.activeHoursEnd,
      activeHoursTimezone: rule.activeHoursTimezone,
      stepsJson: {
        schemaVersion: 1,
        steps: [{
          stepOrder: 0,
          delayMinutes: rule.delayMinutes || 30,
          objective: 'follow_up',
          messageTemplate: rule.template?.content || null,
        }],
      },
      enabled: rule.enabled,
    },
  });

  // 3. Disable old rule (don't delete — backward compat)
  await prisma.automationRule.update({
    where: { id: rule.id },
    data: { enabled: false },
  });
}
```

Run once during Phase 4 deployment. Old rules stay in DB but disabled.

---

## Thread UI States (Suggestion Mode)

### Lead list badge
- 💬 Suggestion available (amber badge)
- ⏰ Follow-up scheduled (grey badge)
- ✅ No active follow-up (no badge)

### Lead detail panel
```
┌─────────────────────────────────┐
│ Follow-up Status                │
│ State: Waiting after initial    │
│ Sequence: Standard Yelp (3/5)   │
│ Next: Suggested in 45 minutes   │
│                                 │
│ [Send Now] [Skip] [Pause]      │
└─────────────────────────────────┘
```

When suggestion fires:
```
┌─────────────────────────────────┐
│ 💡 Follow-up Suggestion         │
│                                 │
│ "Hi Jay, just checking in on    │
│  your deep cleaning request.    │
│  Would Tuesday or Wednesday     │
│  work for a quick call?"        │
│                                 │
│ [✅ Approve & Send] [✏️ Edit]   │
│ [⏭ Skip] [⏸ Pause Sequence]   │
└─────────────────────────────────┘
```

---

## Preset Sequences (Seeded)

Per triggerState × preset = 12 templates total (4 states × 3 presets). Seeded on first deployment via a seed script.

| State | Conservative | Standard | Persistent |
|-------|-------------|----------|------------|
| no_reply_after_initial | 1h, 1d, 3d | 2m, 10m, 1h, 1d, 3d | 2m, 10m, 1h, 1d, 3d, 7d, 14d, 30d |
| no_reply_after_question | 30m, 4h, 1d | 5m, 30m, 2h, 1d, 3d | 5m, 30m, 2h, 1d, 3d, 7d, 14d |
| no_reply_after_price | 2h, 1d, 3d | 30m, 2h, 1d, 3d, 7d | 30m, 2h, 1d, 3d, 7d, 14d, 30d |
| no_reply_after_conversion | 1h, 1d | 15m, 1h, 1d, 3d | 15m, 1h, 1d, 3d, 7d, 14d |

---

## Challenge Loop

### 1. Does this solve the problem?

| Acceptance Criterion | Covered? | Where? |
|---|---|---|
| Existing Yelp settings preserved | ✅ | Migration service maps to new model |
| Follow-ups driven by thread context | ✅ | FollowUpStateService reads ThreadContext |
| Different scenarios → different sequences | ✅ | 4 trigger states × 3 presets |
| Active hours + timezone | ✅ | computeNextDueAt with window snapping |
| Stop on customer reply | ✅ | Idempotent updateMany in webhook handler |
| Suggestion mode works | ✅ | StepExecution status: suggested → approved/skipped/expired |
| Thread UI shows status | ✅ | Cached fields + suggestion card |
| Reusable for Thumbtack | ✅ | Platform field on templates, isolated state derivation |
| Context system is source of truth | ✅ | Engine reads ThreadContext, doesn't duplicate memory |

### 2. Is this the most efficient solution?

| Alternative | Pros | Cons | Verdict |
|---|---|---|---|
| Extend AutomationRule | No new tables | Can't model sequences, steps, audit | ❌ |
| Full 5-table model (+ TransitionRule + Step table) | Maximum flexibility | Over-engineered for v1, more migrations, more joins | ❌ |
| 3-table + stepsJson (chosen) | Simple, versioned, queryable, extensible | Step queries need JSON parsing | ✅ Best balance |

### 3. Is there code for code's sake?

- No TransitionRule table — logic in code ✅
- No Step table — JSON in template ✅
- No branching/A/B — out of scope ✅
- No workflow builder UI — presets only ✅
- Every field serves a specific acceptance criterion ✅

---

## Phase Breakdown

### Phase 1: DB + Module + Scheduler Skeleton
- 3 Prisma models + ThreadContext additions + migration
- Module scaffold (5 files)
- Cron job skeleton (finds due, logs, no execution yet)
- Seed 12 preset templates
- **Gate**: `npx tsc --noEmit` clean, tests pass

### Phase 2: Enrollment + Execution + Stop
- `evaluateThread()` — derive state, enroll
- Scheduler executes steps (suggestion mode only)
- `handleCustomerReply()` — idempotent stop
- Wire into webhook handlers (TT + Yelp)
- `computeNextDueAt()` with active hours + day boundary
- **Gate**: tests for state derivation, enrollment, stop, active hours

### Phase 3: AI Generation + Strategy + Thread UI
- `generateMessage()` — objective + ThreadContext → AI or template
- Strategy integration (activeStrategy → generation style)
- REST endpoints: approve, skip, pause, cancel, list suggestions
- Frontend: suggestion card in lead activity, follow-up status badge
- **Gate**: end-to-end test: lead → enroll → suggest → approve → send

### Phase 4: Settings UI + Migration + Polish
- Services page: preset selector, mode dropdown, scenario config
- Migration service: existing AutomationRule → new model
- Platform-agnostic layer documentation
- **Gate**: migration runs cleanly, no behavioral changes for existing users
