

## TASK — Implement Phone Type Canonical Ownership + Enforce Guards (Pool vs Dedicated vs BYO) + Safe CallConnect Routing

### Context

We have 3 phone types:

1. **Pool (shared, platform-owned)** — used only for tenant alerts (non-customer), cross-tenant allowed
2. **BYO OpenPhone (tenant-owned)** — customer SMS allowed; alerts only if to≠from; no call connect
3. **Dedicated Twilio (tenant-owned)** — customer SMS, alerts, forwarding, CallConnect allowed

Current issues:

* some flows still fall back and allow pool numbers for customer SMS
* forwarding restrictions not enforced
* CallConnect inbound routing must be tenant-safe even after number reprovisioning epochs
* tenant separation must remain correct with shared pool numbers

### Goal

Implement a single consistent “source of truth” per phone type:

* **Pool numbers:** owned by platform pool; never mapped to a tenant allocation in Sigcore
* **Dedicated Twilio numbers:** allocated to tenant Sigcore workspace; canonical owner = tenant
* **BYO OpenPhone numbers:** canonical owner = tenant via OpenPhone connection; validated per-tenant
  Enforce all required guards from the spec.

---

# PART A — LEADBRIDGE CHANGES (Primary enforcement layer)

## A1) Introduce a “phone resolution” function returning phone type + routing context

Create a single function used everywhere:

`resolveFromPhoneContext(tenantId, fromPhoneE164) -> { type, provider, sigcoreKeyMode, sigcoreTenantKey?, platformKey?, phoneId? }`

Return enum:

* `type = POOL | BYO_OPENPHONE | DEDICATED`
* `provider = twilio | openphone`
* `sigcoreKeyMode = PLATFORM | TENANT`
* `sigcoreTenantKey` only if TENANT
* `platform key` only if PLATFORM

Resolution rules:

1. If `fromPhoneE164` exists in `PhonePool` (not released) → **POOL**, provider=twilio, keyMode=PLATFORM
2. Else if tenant has `NotificationSettings.sigcoreFromPhone == fromPhoneE164` and provider=openphone AND ownership validates → **BYO_OPENPHONE**, keyMode=TENANT
3. Else if exists in `TenantPhoneNumber` for tenant and ACTIVE → **DEDICATED**, provider=twilio, keyMode=TENANT
4. Else → error `FROM_PHONE_NOT_CONFIGURED`

**DoD**

* All sending + forwarding logic calls this resolver (no ad-hoc “if/else” scattered).

---

## A2) Enforce guard: Pool numbers blocked from customer SMS everywhere

Update:

* `sendAdHocSms()`
* any “send to customer” paths (rule-based and ad-hoc)
  Guard:
* if `sendToCustomer=true` and resolved type is `POOL` → return 400 `POOL_NOT_ALLOWED_FOR_CUSTOMER_SMS`

**DoD**

* No code path can send customer SMS from pool.

---

## A3) Enforce guard: Alerts must not originate from OpenPhone when sendToCustomer=false

In `sendNotificationWithRule()`:

* if `rule.sendToCustomer=false` (tenant alert):

  * block `BYO_OPENPHONE` as from-phone
  * allow `POOL` or `DEDICATED`
  * keep existing loop guard (toPhone !== fromPhone)

**DoD**

* Alert origin respects spec.

---

## A4) Enforce guard at rule creation/update time

On notification rule create/update:

* if `sendToCustomer=true` then `fromPhone` must resolve to **DEDICATED or BYO_OPENPHONE**
* if `sendToCustomer=false` then `fromPhone` must resolve to **POOL or DEDICATED**
  Return structured errors.

**DoD**

* Invalid rules can’t be saved.

---

## A5) Implement forwarding restrictions and validation

Add validation for settings updates:

* `callForwardingNumber` allowed **only if** tenant has ACTIVE **DEDICATED** number selected for CallConnect / inbound calls
* `smsForwardingNumber` allowed **only if** tenant has ACTIVE **DEDICATED** number
* validate E.164 formatting for forwarding targets
* optionally validate forwarding target is not the same as the dedicated number (avoid loops)

**DoD**

* Forwarding cannot be enabled without dedicated number.

---

## A6) Tenant separation: remove any fallback to platform SIGCORE_API_KEY for tenant BYO/dedicated operations

If `sigcoreTenantApiKey` missing for BYO/dedicated actions:

* return `SIGCORE_TENANT_NOT_PROVISIONED`
  Do not “fallback” to platform key.

**DoD**

* Fixes “tenant phone under admin workspace” class of issues.

---

# PART B — SIGCORE CHANGES (Safe inbound routing + correct ownership model)

## B1) Define canonical ownership in Sigcore:

* Pool numbers are **platform-owned** and should not be present in tenant allocations.
* Dedicated numbers exist as tenant allocations (`tenant_phone_numbers` scoped to tenant key).
* OpenPhone numbers exist as tenant-connected numbers, scoped to tenant key.

**DoD**

* No “tenant allocation” record is created for pool numbers.

---

## B2) CallConnect inbound routing must be ownership-safe and compatible with pool model

In `TwilioWebhooksService.handleIncomingCall` implement:

Algorithm:

1. Read `toNumberE164` from webhook
2. Determine number type:

   * if `toNumberE164` belongs to **platform pool** (Sigcore-side pool registry OR hardcoded list / DB table) → **reject CallConnect** (pool cannot do call connect)
   * else continue
3. Determine tenant owner for dedicated numbers:

   * find allocation in tenant-scoped tables (dedicated twilio allocations), OR
   * look up `call_connect_settings` but **with ownership guard** (see B3)
4. Only if dedicated + CC enabled:

   * forward/bridge to `agentPhoneE164`

**Important**

* CallConnect must be **dedicated-only**.
* Pool numbers must never trigger CC.

**DoD**

* Inbound calls to pool numbers are not forwarded/bridged.

---

## B3) Ownership guard for CC settings

When routing by CC settings:

* never do global `WHERE botNumberE164 = :to` alone

Instead:

* Verify `botNumberE164` is owned by the same `businessId`:

  * `call_connect_settings.businessId` must match the tenant who owns that Twilio number allocation
  * if you don’t have easy lookup by allocation, implement:

    * `assertNumberOwnedByBusiness(botNumberE164, businessId)` using dedicated allocations table
* If ownership fails → do not forward

**DoD**

* Prevent hijack: tenant cannot set CC botNumber to someone else’s number.

---

## B4) Add (or verify) pool registry on Sigcore side (platform scope)

Sigcore needs a source of truth for pool numbers for inbound logic:

* Add table `phone_pool_numbers` (platform scope) or reuse existing phone pool store if Sigcore already has it
  Fields:
* `phoneNumberE164`, `status`, `purpose='leadbridge-alerts'`

Expose read-only:
`GET /v1/pool-numbers` (platform key)

**DoD**

* Sigcore can tell pool vs dedicated during webhooks.

---

# PART C — Integration: Convert pool→dedicated must re-home number correctly

## C1) When LeadBridge converts a pool number to dedicated:

Steps must be:

1. Mark pool number as “removed from pool” (released or converted)
2. Provision/allocate that number into the tenant’s Sigcore tenant workspace (dedicated)
3. Create `TenantPhoneNumber` ACTIVE record in LeadBridge
4. Ensure any CC settings or forwarding settings reference the dedicated number

If the number cannot be re-allocated, conversion must fail (no partial state).

**DoD**

* After conversion, number is no longer treated as pool anywhere.
* It becomes strictly tenant-owned.

---

# Acceptance Tests

## Test 1 — Pool customer SMS blocked

* Configure pool number as fromPhone
* Attempt customer SMS (sendToCustomer=true)
  ✅ blocked with `POOL_NOT_ALLOWED_FOR_CUSTOMER_SMS`

## Test 2 — Alert from OpenPhone blocked

* Configure OpenPhone as fromPhone for alert rule (sendToCustomer=false)
  ✅ blocked on rule save or send path

## Test 3 — CallConnect dedicated-only

* Incoming call to pool number
  ✅ no forwarding/bridge
* Incoming call to dedicated number with CC settings
  ✅ forwarded to agentPhoneE164

## Test 4 — Hijack prevention

* Tenant B sets CC settings with botNumberE164 owned by Tenant A
  ✅ saving blocked OR inbound routing ignores due to ownership guard

## Test 5 — Tenant separation

* Tenant connects OpenPhone
  ✅ admin cannot see tenant numbers; no shared workspace contamination

---

## Notes / Non-goals

* Pool numbers remain shared; “PhonePoolAssignment” is informational only.
* Canonical ownership is:

  * POOL → platform
  * DEDICATED/BYO → tenant

