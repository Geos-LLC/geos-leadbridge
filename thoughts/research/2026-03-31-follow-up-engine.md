# Research: Follow-Up Engine

## What Exists (LeadBridge)

### Current follow-up system:
- AutomationRule with `isFollowUp`, `activeHoursStart/End/Timezone`, `stopOnCustomerReply`
- PendingAutomatedMessage with in-memory timers (setTimeout)
- restorePendingMessages on server restart
- Single delay (delayMinutes) — no sequences
- Active hours check: reschedules 15 min later if outside window
- Stop on customer reply: checked at execution time
- AI mode uses ThreadContext.buildContext() for enriched prompts

### Conversation Context System (already built):
- ThreadContext: stage, summary, stateJson, engagement, strategy, follow-up tracking
- recordMessage() → updateState() → updateSummary()
- buildContext() → systemContext string + recentMessages + threadState
- Stages: new → qualification → quoting → negotiation → booked/lost/closed

### Key gaps:
- Only single follow-up, not sequences
- No state-driven trigger (always "delay after lead")
- No scenario differentiation (no-reply-after-initial vs no-reply-after-price)
- No suggestion mode (always auto-send)
- No sequence switching on stage change
- Timer-based scheduling (lost on restart until restored)

## Industry Patterns

### Universal data model (HubSpot, Salesforce, Outreach, Apollo, Close):
1. **SequenceTemplate** — reusable blueprint (ordered steps + delays)
2. **SequenceStep** — individual step with delay, type, template/AI
3. **SequenceEnrollment** — tracks a contact's progress through a template
4. **SequenceStepExecution** — audit log per step (scheduled → suggested → sent)
5. **SequenceTransitionRule** — stage-to-sequence mapping for auto-switching

### Key denormalization:
- `nextStepDueAt` on enrollment — makes scheduler query trivial
- `currentStepOrder` pointer — tracks position in sequence

### Scheduler pattern:
- **Cron + Queue** (every 60s): `WHERE nextStepDueAt <= NOW() AND status = 'active'`
- NOT pure event-driven (timers lost on restart)
- Event listeners for immediate reactions (stop on reply)
- NestJS `@Cron` or `@nestjs/schedule` sufficient for low volume

### Active hours:
- Compute `nextStepDueAt` with window snapping at step advancement time
- NOT checked at send time (already correct when computed)
- Store send window on settings or per-sequence

### Stop conditions (synchronous with message processing):
- Customer replied → immediate stop (in webhook handler, not scheduler)
- Manual unenroll, sequence completed, bounce/failure

### Suggestion mode:
- Step execution created with `status: 'suggested'`
- User approves → sends; user skips → advance
- Optional auto-expire after configurable hours

## Recommendation

### Architecture:
```
ThreadContext (source of truth)
    ↓ reads
FollowUpEngine (dedicated module)
    ├─ SequenceTemplate (blueprints)
    ├─ SequenceStep (steps with delays)
    ├─ SequenceEnrollment (per-thread progress)
    ├─ SequenceStepExecution (audit)
    └─ SequenceTransitionRule (stage → sequence mapping)
```

### New models (5):
- `follow_up_sequence_templates` — platform-tagged, reusable
- `follow_up_sequence_steps` — ordered with delays and objectives
- `follow_up_enrollments` — one active per conversation, nextStepDueAt indexed
- `follow_up_step_executions` — audit trail
- `follow_up_transition_rules` — optional, stage-to-sequence mapping

### Cached fields on ThreadContext:
- `followUpStatus` (already exists)
- `followUpCount` (already exists)
- Add: `activeEnrollmentId`, `nextFollowUpAt`, `waitingSince`

### Scheduler:
- NestJS `@nestjs/schedule` cron (60s interval)
- Query: `WHERE nextStepDueAt <= NOW() AND status = 'active'`
- Execute or suggest based on enrollment mode

### Migration from existing system:
- Map existing AutomationRule with `isFollowUp: true` to a single-step SequenceTemplate
- Preserve active hours, timezone, template/AI settings
- No breaking changes to existing behavior

### Phases:
1. DB entities + module scaffold + map existing follow-ups
2. Trigger states from ThreadContext + sequence run logic + cron scheduler
3. Suggestion generation + strategy integration + thread UI
4. Settings UI for presets/scenarios + Thumbtack extensibility
