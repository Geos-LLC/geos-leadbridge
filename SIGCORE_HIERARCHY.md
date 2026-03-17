# LeadBridge ↔ Sigcore Hierarchy

## Architecture Overview

```
LeadBridge Platform
│
├── Sigcore Platform Workspace  (ENV key: sc_d24...)
│   └── Pool Numbers  (shared, e.g. +16562231592, +18135927352, ...)
│       Used for: lead alerts only. Routed via platform key.
│
└── LeadBridge Users
    │
    ├── info@spotless.homes
    │   ├── Saved Account: Spotless Homes Jacksonville
    │   │   └── Sigcore Tenant: bf822638  (tenant key)
    │   │       └── BYO: +16562231592  (OpenPhone — disconnected)
    │   │
    │   └── Saved Account: Georgiy Sayapin
    │       └── Sigcore Tenant: 7ef69dcf  (tenant key)
    │           └── BYO: +19045778584  (OpenPhone — disconnected)
    │
    └── sayapingeorge@gmail.com
        └── Saved Account: Spotless Homes Tampa
            └── Sigcore Tenant: 45ea9010  (tenant key)
                ├── BYO: +18139212100  (OpenPhone — active)
                └── Dedicated: +16562188788  (Twilio — ACTIVE, CC enabled)
```

---

## Rules

### 1 Saved Account = 1 Sigcore Tenant
Each Thumbtack/platform account gets its own isolated Sigcore tenant with its own API key.
This means one LeadBridge user can have multiple Sigcore tenants (one per account).

### Phone Number Routing by Type

| Type | Routed via | Sigcore key | SMS | Calls |
|------|-----------|-------------|-----|-------|
| **Pool** | Platform Sigcore Workspace | ENV key (`sc_d24...`) | Alerts only | ❌ |
| **BYO / OpenPhone** | Account's Sigcore Tenant | Tenant key (`sc_ten...`) | Alerts + Customer SMS | ❌ |
| **Dedicated (Twilio)** | Account's Sigcore Tenant | Tenant key (`sc_ten...`) | All SMS | ✅ CC only |

---

## How Numbers Get Registered in Sigcore

### Pool Numbers
- Provisioned by admin in LeadBridge → allocated to platform Sigcore workspace
- Never registered inside tenant workspaces
- Sigcore routes outbound via platform key

### BYO / OpenPhone
- Tenant connects OpenPhone in Notification Settings
- `POST /integrations/openphone/connect { apiKey }` → registers numbers inside the tenant's Sigcore workspace (`tenant_phone_numbers` in Sigcore)
- If the Sigcore tenant is reprovisioned, `sigcoreProvider` is cleared and numbers must be reconnected

### Dedicated (Twilio)
- Tenant purchases via Phone Settings → Stripe → Twilio number bought
- Allocated to the account's Sigcore tenant
- Registered in Sigcore's `tenant_phone_numbers` for that workspace
- Used as `botNumberE164` in CC settings — Sigcore routes inbound calls by looking up this number

---

## Cross-Contamination Risk (Historical — Fixed)

**Before Part D fix:** Both accounts used the same ENV Sigcore key → same workspace → CC settings overwrote each other → calls went to wrong number.

**After Part D fix:** Each account uses its own tenant Sigcore key exclusively. ENV key is only used for pool number routing.

---

## Current State (as of 2026-03-05)

| User | Account | Sigcore Tenant | Phone | Type | CC |
|------|---------|---------------|-------|------|----|
| info@spotless.homes | Spotless Homes Jacksonville | bf822638 | +16562231592 | BYO (disconnected) | Disabled |
| info@spotless.homes | Georgiy Sayapin | 7ef69dcf | +19045778584 | BYO (disconnected) | Disabled |
| sayapingeorge@gmail.com | Spotless Homes Tampa | 45ea9010 | +18139212100 | BYO (OpenPhone, active) | — |
| sayapingeorge@gmail.com | Spotless Homes Tampa | 45ea9010 | +16562188788 | Dedicated (Twilio, active) | Enabled |
