

---

## 🔧 Task: Add Urgent Request Handling to AI Context & Behavior

Implement support for business urgency capability in AI message generation and follow-up logic.

### 1. Store setting

Add field to business settings:

```json
{
  "urgentCapability": "same_day" | "24h" | "48h" | "none"
}
```

---

## 2. Inject into AI context

Every AI generation (reply + follow-up) must include:

```json
{
  "customerUrgency": "low" | "medium" | "high",
  "urgentCapability": "same_day" | "24h" | "48h" | "none"
}
```

---

## 3. Detect customer urgency (v1 rule-based)

Set `customerUrgency = high` if message contains:

* “ASAP”
* “today”
* “urgent”
* “as soon as possible”
* “right away”
* “tonight”
* “this morning / afternoon”

Else:

* medium / low (simple fallback is fine for v1)

---

## 4. Add global prompt rules

Extend global prompt with:

```text
Urgency handling:

- If customer urgency is high, acknowledge urgency clearly.
- Do NOT promise availability beyond business capability.
- If business cannot meet requested urgency, offer the closest available option.

Examples of behavior:
- same_day → proceed normally, prioritize fast response
- 24h → shift from "today" to "tomorrow"
- 48h → offer near-term availability without implying same-day
- none → acknowledge urgency but redirect to next available slot

- Keep tone helpful and realistic, never misleading.
```

---

## 5. Behavior mapping (important)

### Case A — Match

Customer: urgent
Business: same_day

👉 Behavior:

* fast, direct
* move to conversion quickly

---

### Case B — Partial match

Customer: today
Business: 24h

👉 Behavior:

* acknowledge urgency
* shift expectation

Example logic:

> “We may not have same-day, but we can schedule for tomorrow”

---

### Case C — No match

Customer: urgent
Business: none

👉 Behavior:

* acknowledge urgency
* do NOT push urgency follow-ups
* offer realistic timeline

---

## 6. Adjust follow-up timing

Modify follow-up engine:

```text
IF customerUrgency = high AND urgentCapability = same_day
→ use accelerated timing

IF customerUrgency = high AND urgentCapability != same_day
→ DO NOT accelerate aggressively
→ use moderate timing

IF urgentCapability = none
→ avoid aggressive follow-ups entirely
```

---

## 7. Do NOT let AI hallucinate availability

Strict rule:

```text
Never imply same-day or urgent availability unless urgentCapability = same_day.
```

---

## 8. Keep it invisible in UI

* Do NOT expose this logic in conversation UI
* Only influence:

  * message generation
  * follow-up timing

---

## 9. Optional (nice to have later)

Store in thread state:

```json
{
  "customerUrgency": "high",
  "urgencyHandled": true
}
```

---

# ✅ Summary for agent

* Add `urgentCapability` setting
* detect urgency from message
* inject both into AI context
* adjust messaging + follow-ups
* never overpromise

---

# 🧠 Why this is important

This turns your AI from:
❌ generic responder

into:
✅ **realistic operator aligned with business capacity**


