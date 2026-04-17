

## AI-agent task: minimal UI correction for LeadBridge automation page

### Goal

Make the current automation UI clearer **without global redesign, backend changes, or new flows**.

Keep the existing structure and logic as much as possible.
Only adjust **labels, grouping, helper text, and section placement** so the user better understands:

1. what happens when a new lead arrives
2. what happens if the lead does not respond
3. what AI does beyond the first reply

---

## Important constraints

* **Do not redesign the page from scratch**
* **Do not remove existing functionality**
* **Do not change backend behavior**
* **Do not introduce new pricing/tier logic in code**
* **Do not create a new architecture**
* Only make **minimal UI/content/organization changes**
* Preserve all existing settings and controls unless explicitly renamed or moved below

---

## Main product clarification to reflect in UI

The current UI mixes together:

* first automatic reply
* team alerting / instant contact
* ongoing AI conversation
* follow-ups

We need to clarify these with minimal changes.

### Key product logic to reflect

* **First message only + team escalation/contact** belong together as the main “new lead came in” value
* **Follow-ups** are for leads who did not respond
* **AI conversation** is not the same thing as first reply; it is ongoing conversation handling

---

# Required UI changes

## 1) Keep current top account/number area mostly unchanged

Keep:

* Select Account
* LeadBridge Number
* Your Business Phone
* Test Number
* Test Alert / Test Text / Test Call

### Small label update

Rename:

**“🤖 Bot Number”** → **“🤖 LeadBridge Number”**

Keep the helper text similar:

> Customers receive texts and calls from this number.

Reason:
“Bot Number” sounds too technical and lower-trust.

---

## 2) Create a clearer visual grouping for the first-response flow

Do **not** rebuild components.
Just visually group the existing first-response / alert / immediate-contact items under one parent section.

### New parent section title:

## **New Lead Handling**

### New helper text:

> What happens immediately when a new lead arrives.

This section should contain the existing pieces that already exist on the page:

* Lead Notifications / Lead Alerts
* Auto Reply
* Customer Communications items related to immediate texting/calling
* Instant Call Connect

Do not change their actual logic unless noted below.

---

## 3) Rename “Lead Notifications”

Rename:

**“Lead Notifications”** → **“New Lead Alerts”**

Keep status indicator if present.

Update helper text to something like:

> Get notified as soon as a new lead arrives.

---

## 4) Rename “Auto Reply”

Rename:

**“Auto Reply”** → **“Instant Reply”**

Update helper text to:

> Send the first message automatically when a new lead arrives.

This is important: this block must clearly represent **first message only**, not full conversation automation.

---

## 5) Rename fields inside Instant Reply

Rename:

**“Reply Type”** → **“Instant Reply Mode”**

Options:

* **📝 Template Reply**
* **✨ AI Reply**

Rename:

**“First Reply Prompt”** → **“AI Reply Instructions”**

Do not change the underlying prompt behavior.
This is only a UX/content rename.

---

## 6) Keep first-response value tied to escalation/contact

Because first message alone is not enough value, the UI should make it visually clear that the user can also immediately notify/contact from the same “new lead” moment.

Within the new **New Lead Handling** section, keep and reposition these blocks so they feel related:

* New Lead Alerts
* Instant Reply
* Customer texting block for immediate outreach
* Instant call block

Do not create a new backend bundle.
This is just a **UI grouping**, not forced product bundling.

---

## 7) Rename “Customer Communications”

There are currently duplicated / confusing “Customer Communications” blocks.

Rename the section label everywhere it appears as:

**“Customer Communications”** → **“Customer Contact”**

Helper text:

> Text or call leads from your LeadBridge number.

If there are two duplicated headers with the same name, clean that up so the page only shows the label consistently and doesn’t feel duplicated/confusing.

Do not remove functionality.
Just make naming consistent.

---

## 8) Rename “Customer Texting”

Rename:

**“Customer Texting”** → **“Instant Text”**

Helper text:

> Automatically text the lead when a new lead arrives.

This keeps it specific to the initial-contact moment.

---

## 9) Rename “Instant Call Connect”

Rename:

**“Instant Call Connect”** → **“Instant Call”**

Helper text:

> Call your team and connect to the lead right away when a phone number is available.

Do not change modes like:

* Agent First
* Parallel

Do not change whisper/voicemail functionality.

---

## 10) Remove “Yelp” from the follow-up section title

The follow-up engine may remain Yelp-only technically for now, but the UI should not hard-code that into the main feature title.

Rename:

**“Yelp Follow-ups”** → **“Follow-ups”**

Update helper text to:

> Automated follow-ups for leads who don’t respond. Best for chat-based leads like Yelp.

This keeps it truthful without forcing Thumbtack support in the UI.

Important:

* do not pretend follow-ups are fully enabled for all channels if they are not
* do not add new support logic
* just remove the platform name from the title and clarify it in helper text

---

## 11) Clarify that AI conversation is separate from first reply

This is the most important conceptual fix.

Right now AI is shown mainly as part of first reply / follow-ups, but the product also has the concept of **AI ongoing conversation handling**.

We do **not** want a big redesign.
We only want a minimal clarification.

### Add a small AI subsection or card title inside the existing follow-up area:

## **AI Conversation**

Helper text:

> Let AI continue the conversation after the first reply.

This should reuse existing AI-related settings already on the page, especially:

* AI Reply
* AI Strategy
* related AI behavior in follow-ups

Do not create a new backend module if one does not exist.
This is mostly a **presentation / grouping change** so users understand:

* **Instant Reply** = first message only
* **AI Conversation** = ongoing AI handling after that

If needed, place **AI Conversation** directly above the current AI Strategy area.

---

## 12) Adjust follow-up wording to separate timing vs AI handling

Inside the Follow-ups section:

Keep the timing plan and schedule UI.

But make the mental model clearer:

* **Follow-ups** = when and how often we continue after no response
* **AI Conversation** = whether AI writes and guides the messages

### Rename:

**“Follow-up Mode”** options currently shown as Templates / AI Reply

Update to:

* **Templates**
* **AI Conversation**

This is just a wording change if possible in current UI.

If changing the option labels is too coupled technically, keep the control but add helper text under it:

> Choose whether follow-ups use preset templates or AI conversation handling.

---

## 13) Keep AI Strategy, but clarify it

Keep the current strategies:

* Auto
* Hybrid
* Price
* Qualify
* Convert
* Phone

Update helper text to:

> Choose how AI should guide the conversation.

If “Auto” already means AI picks based on context, keep that wording.

---

## 14) Preserve current availability / active hours logic

Keep:

* Always (24/7)
* Set up active time
* current off-hours / availability behavior

But ensure the wording in each block matches the concept:

* Instant Reply availability applies to the first reply
* Follow-up / AI conversation availability applies to continued messages

No backend change required unless it is already shared logic.

---

# Desired final page structure (minimal UI-level grouping)

Keep the same page, but organize it visually like this:

## Top account/number area

* Select Account
* LeadBridge Number
* Your Business Phone
* Test Number
* test buttons

## New Lead Handling

* New Lead Alerts
* Instant Reply
* Customer Contact

  * Instant Text
  * Instant Call

## Follow-ups

* Follow-up settings/timing
* AI Conversation
* AI Strategy
* Availability
* historical lead enrollment

This is a **presentation/grouping update**, not a rebuild.

---

# Content/style guidance

* Use clear product language, not internal/technical naming
* Avoid duplicate labels
* Avoid platform-specific naming unless necessary
* Keep descriptions short and practical
* Make the flow easy to understand in chronological order:

  1. new lead arrives
  2. we respond / notify / contact
  3. if no reply, follow up
  4. AI can continue the conversation

---

# Explicitly do NOT do

* Do not add new navigation
* Do not create a new pricing page
* Do not implement new entitlements
* Do not change business logic for Thumbtack vs Yelp
* Do not connect OpenPhone or ServiceFlow here
* Do not refactor backend automation models
* Do not introduce a new onboarding flow
* Do not remove any existing settings advanced users may rely on

---

# Acceptance criteria

The updated page should make it obvious that:

1. **Instant Reply** is only the first message
2. **New Lead Handling** includes both immediate reply and immediate escalation/contact
3. **Follow-ups** are for silent leads
4. **AI Conversation** is ongoing AI handling, not just the first auto-reply
5. The page no longer feels Yelp-only, even if some functionality is still best suited for Yelp
6. Naming is more understandable without changing the underlying product logic

