

**Task: Adjust LeadBridge Follow-Ups UI and System Logic**

Refactor the current Yelp Follow-ups UI and underlying logic to match the clarified product model.

## Goal

Make the Follow-ups system simpler and more correct by:

* keeping **visible strategy selection** as the main user-facing AI control
* keeping **follow-up scenarios internal** as system state
* treating follow-ups as **default ON for unresolved conversations**
* defining only clear **stop conditions**
* separating short-term **conversation follow-ups** from future **reactivation / repeat-job reminders**
* incorporating **urgent request capability** correctly into AI behavior

---

## 1. Core model to enforce

### Visible to user

Keep only these visible AI strategy options in conversation threads:

* Hybrid
* Price
* Qualify
* Convert
* Phone

These remain the main user-facing AI response choices and preview buttons.

### Internal only

Keep these as **internal follow-up states/scenarios**, not a separate user-facing prompt system:

* no reply after first response
* no reply after question
* no reply after price
* no reply after booking step

These should be derived from thread context and used by the system to influence follow-up generation, timing, and sequence selection.

They should **not** appear as a complex settings section users need to configure.

---

## 2. Unify prompt system

Right now there are two prompt systems:

* strategy prompts in Lead Activity
* objective prompts in follow-up generator

Refactor so that:

### Follow-up generation uses:

* `suggestStrategy()`
* the same visible strategy prompts used in Lead Activity

### Old objective-based prompts should remain only as:

* step-level flavor / modifier / objective
* not a separate parallel prompt system

### Final generation flow should be:

`thread context/state -> scenario derivation -> suggestStrategy() -> selected strategy prompt -> step objective/flavor -> final message`

### Important

If user manually selects a strategy in the conversation thread, user choice must override suggested strategy.

---

## 3. Remove “Scenarios” as a user-config section

The current UI has a “Scenarios” section:

* After first reply
* After question asked
* After price shared
* After booking step

This is confusing because we do not want users configuring scenario logic directly.

### Change required

Remove “Scenarios” as an editable settings block.

### Replace with a simple explanatory line in Follow-ups settings:

Example:

* “Follow-ups automatically adapt to the conversation stage, such as after no reply, after questions, after pricing, or after booking steps.”

### Keep scenario visibility only contextually

In thread UI / automation panel, it is okay to show simple status labels like:

* Waiting after price
* Waiting after question
* Next follow-up in 1 hour

But do not expose scenarios as a separate prompt/setup system in settings.

---

## 4. Fix stop rules logic

### Current confusion

“Stop automatic follow-ups when Customer replies” is confusing because the first reply is handled by Alerts, not Follow-ups.

### Correct logic

There are 3 categories:

#### A. Hard stop conditions

These should stop future follow-ups:

* Customer asks to stop / says do not contact
* Conversation is archived on Yelp
* Job is booked or confirmed

#### B. Sequence stop / reset

* Customer replies → stop the **current follow-up sequence only**
* A new sequence may later begin after the next unanswered outbound message

#### C. Default behavior

For all other unresolved cases, follow-ups should continue by default.

### UI changes

Replace current wording with clearer wording.

Use something like:

**Follow-ups stop when:**

* Customer asks not to be contacted
* Conversation is archived
* Job is booked or confirmed

**Current follow-up sequence stops when:**

* Customer replies

Do **not** use vague wording like:

* “If customer says no”

Remove that setting entirely.

---

## 5. Add archive-based stop rule

Integrate Yelp archive status into follow-up logic.

### Requirement

If a conversation is archived on Yelp:

* stop follow-ups
* do not schedule new ones unless explicitly reactivated later

This should be treated as a hard stop condition.

---

## 6. Separate follow-ups from reactivation / repeat jobs

Important product distinction:

### Follow-ups

Short-term, tied to unanswered conversation steps:

* after first response
* after question
* after price
* after booking step

### Reactivation / repeat jobs

Long-term lifecycle reminders:

* after service completed
* re-engage customer in 30 / 60 / 90 days
* “time for next cleaning”

### Requirement

Do **not** mix repeat-cleaning reminders into the current Follow-ups system.

For now:

* keep follow-ups focused on unresolved conversations only

### Optional placeholder

If useful, add a TODO / future extensibility note in code or product copy:

* Repeat Jobs / Reactivation will be a separate future module

---

## 7. Add urgent request capability setting

We decided to add a business-side capability setting, because not every business can handle same-day jobs.

### Add business setting

**How do you handle urgent requests?**

* Same-day available
* Within 24 hours
* Within 48 hours
* No urgent availability

Store as something like:

* `same_day`
* `24h`
* `48h`
* `none`

### System behavior

Inject into AI context and follow-up logic.

AI must:

* acknowledge urgency if customer is urgent
* never promise availability beyond business capability
* shift the offer accordingly

Examples:

* same_day → move fast and try to convert
* 24h → acknowledge urgency and offer tomorrow / next available
* 48h → offer near-term but not same-day
* none → acknowledge urgency but do not imply urgent availability

### Follow-up timing behavior

If lead is urgent:

* accelerate only when business can actually support urgency
* do not aggressively accelerate when urgent capability is limited or none

---

## 8. Keep Follow-ups UI simple

Current structure is good:

* Follow-up Mode
* Reply Type
* Follow-up Timing / Plan
* Auto Reply Availability
* Smart Follow-up Rules

Refine the labels and logic.

### A. Keep

* Off / Suggest / Auto-send
* Template / AI Follow-up
* Smart timing / Custom timing
* Always / Only during active hours
* Active hours + timezone

### B. Improve wording

Rename “Follow-up Timing” to something closer to:

* Follow-up Plan

Reason: this is sequence-based, not a single delay.

### C. Add transparency

For Smart timing, show a preview of the timing sequence instead of vague wording.

Example:

* 2 min
* 10 min
* 1 hour
* 1 day
* 3 days
* 7 days

### D. Add note that adaptation is automatic

Instead of editable scenarios, show a short explanation that timing and messaging adapt based on the conversation stage.

---

## 9. Conversation thread UI changes

In the conversation thread, keep the current strategy preview area as the main visible control.

Add lightweight internal/debug visibility, but do not clutter UI with many buttons.

### Keep

* strategy chips/buttons
* strategy percentages/scores
* preview + choose flow

### Add

A compact explanation / status area, for example:

* Suggested: Price
* Reason: customer asked about pricing, details still missing
* Next follow-up: in 1 hour
* State: waiting after price

### Optional

Expose more detail in a collapsible drawer / AI panel, not inline.

Do not add multiple extra buttons directly in the main thread action row.

---

## 10. Default follow-up logic summary to implement

### Default assumption

If conversation is unresolved, follow-ups continue according to plan.

### Stop follow-ups only when:

* customer explicitly asks not to be contacted
* conversation is archived
* booking is confirmed

### Stop current sequence only when:

* customer replies

### Do not treat these as hard stop by default:

* “not interested”
* “already hired someone”
* “maybe later”

Those should stop the current sequence if needed, but may be eligible for future reactivation later. Do not build reactivation into this module yet.

---

## 11. Deliverables

Please implement:

1. UI refactor for Follow-ups settings based on the above
2. remove editable “Scenarios” section from settings
3. unify follow-up generator with shared strategy prompt system
4. keep scenarios as internal state only
5. revise stop rule logic and wording
6. add archive stop behavior
7. add urgent request capability setting + AI/system handling
8. keep repeat-job / reactivation out of current follow-up system
9. update thread UI copy/statuses for clarity

---

## 12. Important implementation note

Do not overcomplicate the user-facing setup.

The product should feel like:

* simple strategy selection
* simple follow-up rules
* smart adaptation happens automatically

Not:

* a workflow builder
* a scenario configuration tool
* a prompt-engineering dashboard

---