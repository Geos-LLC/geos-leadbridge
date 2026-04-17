Use this task for the AI agent:

Refactor the Yelp Follow-ups settings UI to simplify it around three clear concepts: reply automation mode, follow-up timing, and stop rules.

Current problem:
The existing UI is too hard to understand for users because “Follow-up Pace” is abstract, “Active Hours” is mixed with automation behavior, and the relationship between manual/template follow-ups and AI follow-ups is unclear.

Goal:
Make the settings feel simple and business-oriented, while keeping advanced behavior available behind an expandable section.

Requirements:

1. Keep the product scope the same

* This is still for Yelp follow-ups sent via Yelp chat
* Keep support for both template-based follow-ups and AI-generated follow-ups
* Keep support for manual review / suggest mode and auto-send mode
* Keep scenario-level activation (After first reply, After question asked, After price shared, After booking step)

2. Replace “Follow-up Pace”
   Remove the current:

* Conservative — 3 steps, gentle
* Standard — 5 steps, balanced
* Persistent — 8 steps, aggressive

Replace it with a clearer timing model:

New section:
Follow-up Timing

Description:
Choose when the next follow-up should be sent if the customer does not reply.

Options:

* Smart timing (recommended)
* Custom timing

If Custom timing is selected, show editable per-step timing inputs such as:

* 1st follow-up → [2 minutes]
* 2nd follow-up → [1 hour]
* 3rd follow-up → [1 day]

This timing model must work for both Template and AI Follow-up reply types.
Important:
AI does not decide when to send the next follow-up. The system schedules the timing, and AI generates the message at the scheduled time.

3. Rename / reposition “Active Hours”
   The current “Active Hours” section is actually about when automatic messages are allowed to send.

Rename this section to:
Auto Reply Availability

Description:
Choose when follow-ups can be sent automatically.

Options:

* Always (24/7)
* Only during active hours

If “Only during active hours” is selected, show:

* Start time
* End time
* Timezone

This setting should clearly apply to automatic sending behavior, not to manual review mode.

4. Clarify Follow-up Mode
   Keep:

* Off
* Suggest
* Auto-send

But improve the wording:

Off
No follow-ups

Suggest
Review each follow-up before sending

Auto-send
Send follow-ups automatically

This should be visually separated from Reply Type.

5. Clarify Reply Type
   Keep:

* Template
* AI Follow-up

Improve the helper text:

Template
Use fixed follow-up messages

AI Follow-up
Generate contextual follow-ups based on the conversation

For AI Follow-up, remove technical wording like:
“using conversation summary, thread state, and your prompt strategy”

Replace it with simple user-facing language.

6. Add advanced rules section
   Add a collapsed section:
   Smart Follow-up Rules
   Helper text:
   Control when automatic follow-ups stop and how special cases are handled.

When expanded, show:

Stop automatic follow-ups when

* Customer replies
* Customer asks to stop
* Job is booked or confirmed

If the customer says no

* Stop follow-ups
* Try again later

If “Try again later” is selected:

* Follow up again after [7 days dropdown/input]

Urgent leads

* Move faster when the customer needs service ASAP

Default hidden values:

* Stop on reply = on
* Stop on opt-out = on
* Stop on booked/confirmed = on
* If customer says no = Try again later after 7 days
* Urgent leads = on

7. Keep scenario section, but make it easier to scan
   Keep the four scenarios:

* After first reply
* After question asked
* After price shared
* After booking step

Each scenario should still allow Active / Off state.
Improve spacing and readability so the section feels lighter and easier to scan.

8. Recommended final layout
   Please adjust the settings card to this structure:

Yelp Follow-ups
Short description

1. Follow-up Mode
   Off / Suggest / Auto-send

2. Reply Type
   Template / AI Follow-up

3. Follow-up Timing
   Smart timing / Custom timing
   (if custom, show timing steps)

4. Auto Reply Availability
   Always (24/7) / Only during active hours
   (if limited, show start/end/timezone)

5. Scenarios
   Scenario toggles

6. Smart Follow-up Rules
   Collapsed advanced section

7. Save button

8. UX direction

* Reduce cognitive overload
* Use plain business language, not system logic language
* Hide advanced controls by default
* Keep defaults strong enough that most users do not need advanced setup
* Make AI Follow-up feel like the smart recommended option without making Template feel broken

10. Deliverables

* Updated settings card structure
* Revised labels and helper text
* Updated interaction logic for the new timing model
* Updated hidden advanced section
* Keep implementation aligned with current design system and existing settings architecture
