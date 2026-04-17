# Strategy Buttons + Context Integration — Handoff

## What needs to happen

### 1. Connect strategy buttons to conversation context system
- Currently: buttons call aiApi.previewForLead() with raw Message[] history
- Target: use buildContext() → summary + state + recent messages
- File: frontend/src/pages/Messages.tsx (strategy button section ~line 1440)
- Backend: POST /v1/ai/preview-for-lead already exists, needs to accept threadContext

### 2. AI strategy suggestion based on context
- New: auto-suggest which strategy (Hybrid/Price/Qualify/Convert) based on ThreadContext
- Backend endpoint: POST /v1/conversation-context/:id/suggest-strategy
- Uses: stage, priceDiscussed, missingFields, engagementLevel, lastQuestionAsked
- Returns: { suggested: 'price', reason: 'Customer asked about pricing...', confidence: 0.8 }

### 3. New UI sections in lead activity (collapsed by default)
- Section 1: Mode selector (Full context / Light / No context)
- Section 2: Why this answer — shows suggested strategy + reason
- Section 3: Context panel — summary, state fields, "View full context" link
- Section 4: Prompt panel — shows which strategy + objective
- Section 5: Regenerate buttons (Full/Light/None)

### Key files
- frontend/src/pages/Messages.tsx — strategy buttons area (~1440)
- src/ai/ai.service.ts — generateReply()
- src/ai/ai.controller.ts — previewForLead endpoint
- src/conversation-context/conversation-context.service.ts — buildContext()
- src/conversation-context/conversation-context.controller.ts — new suggest-strategy endpoint

### Strategy suggestion rules (rule-based v1)
- price_shopping + !priceDiscussed → suggest Price
- missingFields.length > 0 → suggest Qualify
- engagementLevel == 'hot' → suggest Convert
- default → suggest Hybrid
