# Follow-Up Engine — Phase 3 Handoff

## Status
- Phase 1 ✅: DB schema (3 tables + ThreadContext fields), module scaffold, seed presets, 35 tests
- Phase 2 ✅: Webhook wiring (evaluate + stop), scheduler execution (suggest + auto_send), getThreadState extended
- Phase 3 TODO: AI generation, strategy integration, REST approve/skip, thread UI

## What Phase 3 needs to deliver

### 1. FollowUpGeneratorService — full implementation
- File: src/follow-up-engine/follow-up-generator.service.ts (currently stub)
- AI mode: use ConversationContextService.buildContext() + step objective → AiService.generateReply()
- Template mode: use step.messageTemplate with variable personalization
- Inject activeStrategy from ThreadContext
- Return { message, objective, strategyUsed }

### 2. Auto-send: actually send via platform
- In scheduler processEnrollment(), when mode='auto_send':
  - Call LeadsService.sendMessage() to send via Yelp/TT adapter
  - Record in ConversationContextService.recordMessage()
  - Store messageId in StepExecution
- Need LeadsService injected (or via PlatformFactory)

### 3. REST endpoints for suggestion lifecycle
- POST /v1/follow-ups/suggestions/:id/approve — approve & send suggested message
- POST /v1/follow-ups/suggestions/:id/skip — skip this step, advance sequence
- POST /v1/follow-ups/suggestions/:id/edit — edit message then send
- These are in follow-up-engine.controller.ts (stubs exist for list)

### 4. Frontend: lead activity suggestion card
- In Messages.tsx lead detail panel, show:
  - Follow-up status badge on lead list
  - Suggestion card when status='suggested'
  - Approve/Skip/Edit/Pause actions
- Load via GET /v1/follow-ups/suggestions (already has endpoint)

## Key files
- src/follow-up-engine/follow-up-generator.service.ts — STUB, needs full impl
- src/follow-up-engine/follow-up-scheduler.service.ts — processEnrollment() auto_send path needs real send
- src/follow-up-engine/follow-up-engine.controller.ts — needs approve/skip/edit endpoints
- src/ai/ai.service.ts — generateReply() already works, need to call with follow-up context
- src/conversation-context/conversation-context.service.ts — buildContext() already works
- frontend/src/pages/Messages.tsx — needs suggestion card UI

## Tests to write
- Generator: AI mode returns contextual message, template mode returns personalized text
- Approve flow: suggested → approved → sent → message in conversation
- Skip flow: suggested → skipped → advance to next step
- Expired: suggested → expired after timeout
