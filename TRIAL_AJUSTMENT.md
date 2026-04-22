Here’s a **clean, production-level AI agent task** to adjust your trial system. This is structured so your dev/AI agent can implement it without ambiguity.

---

# 🧠 AI Agent Task: Adaptive Trial System (LeadBridge)

## 🎯 Objective

Replace the current **fixed “10 leads trial”** with an **adaptive trial system** that:

* Works for **Thumbtack (high volume)**
* Works for **Yelp (low volume)**
* Works for **mixed users**
* Prevents abuse
* Maximizes conversion
* Keeps UX simple (“free trial” — no confusing credits)

---

# 📦 Core Concept

Trial is determined dynamically based on connected platforms:

| Scenario  | Trial Type |
| --------- | ---------- |
| Only TT   | Lead-based |
| Only Yelp | Time-based |
| Both      | Hybrid     |

---

# 🧱 Data Model Changes

### Add to `accounts` (or `organizations`)

```ts
trialType: 'LEAD_BASED' | 'TIME_BASED' | 'HYBRID'

trialStartAt: Date
trialEndsAt: Date | null

trialLeadLimit: number | null
trialLeadsUsed: number

trialActive: boolean
trialEndedAt: Date | null
```

---

# ⚙️ Trial Initialization Logic

Trigger: **when first platform is connected OR first lead received**

```ts
if (connectedPlatforms === ['thumbtack']) {
  trialType = 'LEAD_BASED'
  trialLeadLimit = 10
  trialEndsAt = now + 7 days (optional safety)
}

if (connectedPlatforms === ['yelp']) {
  trialType = 'TIME_BASED'
  trialEndsAt = now + 14 days
  trialLeadLimit = null (or high, e.g. 30)
}

if (connectedPlatforms includes both) {
  trialType = 'HYBRID'
  trialEndsAt = now + 14 days
  trialLeadLimit = 15
}
```

---

# 🔁 Platform Change Logic (IMPORTANT)

When user connects a new platform AFTER trial started:

### Rule:

> Only **upgrade** trial, never restrict

```ts
if (trialType === 'TIME_BASED' && user adds TT) {
  trialType = 'HYBRID'
  trialLeadLimit = 15
}

if (trialType === 'LEAD_BASED' && user adds Yelp) {
  trialType = 'HYBRID'
  trialEndsAt = now + 14 days (or keep original if shorter)
}
```

Do NOT reduce limits or shorten time.

---

# 📊 Lead Consumption Logic

Trigger: **when first auto-response is sent**

```ts
function canProcessLead(account, platform) {
  if (!account.trialActive) return true

  if (account.trialType === 'TIME_BASED') {
    return now < trialEndsAt
  }

  if (account.trialType === 'LEAD_BASED') {
    return trialLeadsUsed < trialLeadLimit
  }

  if (account.trialType === 'HYBRID') {
    return (
      now < trialEndsAt &&
      trialLeadsUsed < trialLeadLimit
    )
  }
}
```

---

### Deduct lead

```ts
onFirstAutoResponse(lead) {
  if (trialActive) {
    trialLeadsUsed += 1
  }
}
```

---

# 🚫 Blocking Logic (CRITICAL UX RULE)

Before processing a new lead:

```ts
if (!canProcessLead(account, platform)) {
  blockAutomation(lead)
  showUpgradePrompt()
  return
}
```

---

## ❗ Important:

* DO NOT partially process leads
* If blocked → no auto-reply, no follow-up
* Existing conversations → allowed to continue (see below)

---

# 🔄 Existing Conversations Rule

If trial ends:

* Leads already processed:

  * ✅ allow current sequence to finish OR
  * ✅ allow 24-hour grace period

* New leads:

  * ❌ blocked immediately

---

# ⛔ Trial End Conditions

```ts
if (trialType === 'TIME_BASED' && now >= trialEndsAt) → end trial

if (trialType === 'LEAD_BASED' && trialLeadsUsed >= trialLeadLimit) → end trial

if (trialType === 'HYBRID' &&
    (now >= trialEndsAt || trialLeadsUsed >= trialLeadLimit)) → end trial
```

---

# 🎨 UI Requirements

### Show ONE simple message only:

#### TT:

> Free trial: 10 leads

#### Yelp:

> Free trial: 14 days

#### Both:

> Free trial: 14 days or 15 leads

---

### Progress indicators:

#### Lead-based:

> 7 / 10 leads used

#### Time-based:

> 5 days remaining

#### Hybrid:

> 5 days left • 8 / 15 leads used

---

# 🔥 Paywall Behavior

When trial ends:

* Disable:

  * auto-reply
  * follow-ups
  * AI actions

* Keep visible:

  * leads list
  * conversations

* Optional (recommended):

  * blur phone number
  * show:

    > “Upgrade to respond to this lead”

---

# ⚠️ Edge Cases

### 1. Race condition (multiple leads at same time)

* Use atomic increment for `trialLeadsUsed`
* Prevent exceeding limit

---

### 2. Retry/webhook duplicates

* Deduct only once per lead
* Use `lead.processedAt` or flag

---

### 3. Manual actions

* If user manually replies → allowed (optional decision)
* But automation stays blocked

---

### 4. No leads during trial

* TIME-based ensures they still see value

---

# ✅ Acceptance Criteria

* Trial adapts correctly based on platform(s)
* No abuse from TT high volume
* Yelp users don’t get “empty trial”
* No partial automation behavior
* Clear UI messaging
* Conversion trigger at trial end

---

# 🚀 Optional (Phase 2)

* Dynamic limits (based on usage patterns)
* Conversion triggers (when 80% used)
* Email/SMS reminders:

  * “You have 2 leads left”
  * “Trial ends in 2 days”

---

# 🧩 Summary for Agent

> Implement an adaptive trial system that switches between lead-based, time-based, and hybrid models depending on connected platforms, enforces limits at the moment of first auto-response, prevents partial lead processing, and cleanly transitions to a paywall when limits are reached.

---

