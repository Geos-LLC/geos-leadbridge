

**Task: Prepare implementation plan for bi-directional job status sync between Service Flow and LeadBridge**

## Context

Today, **LeadBridge → Service Flow** already exists as a one-way integration. LeadBridge sends lead and messaging events into Service Flow.

However, **job status changes are actually managed day-to-day inside Service Flow**, not inside LeadBridge. In practice:

* leads often convert to jobs inside **Service Flow**
* job / lead statuses are updated in **Service Flow**
* LeadBridge currently learns about some of these changes only when we run a manual/platform sync via the extension
* Yelp / Thumbtack still remain the source of truth for certain discrepancies, so we cannot fully remove platform sync yet

This means the current model is inefficient:

* status changes happen in SF first
* LB does not get them back in real time
* follow-ups / automation inside LB may continue based on stale status
* extension sync is doing work that should mostly be event-driven

## Goal

Prepare a **technical implementation plan** for a new system where:

1. **Service Flow pushes job status changes back to LeadBridge**
2. **LeadBridge updates its internal lead/job status from Service Flow in near real time**
3. **Periodic platform sync still exists for Yelp/Thumbtack discrepancy detection and correction**
4. The system clearly defines:

   * which source is authoritative for which type of status
   * when SF wins
   * when platform sync wins
   * how conflicts are resolved
   * how follow-ups / automation react to incoming status changes

## Preferred direction

The preferred architecture is **webhook-first**, not polling.

### Proposed shape

#### Service Flow side

When a job/lead status changes in SF, emit an outbound webhook event such as:

* `job.status_changed`

Example payload concept:

```json
{
  "leadId": "<LeadBridge externalRequestId or mapped external platform lead id>",
  "oldStatus": "open",
  "newStatus": "scheduled",
  "jobId": "<service-flow-job-id>",
  "timestamp": "<iso datetime>",
  "source": "service_flow"
}
```

Requirements:

* fire from the real place(s) where SF updates job/job-lead status in DB
* sign webhook with HMAC-SHA256 using shared secret
* support retries / idempotency

#### LeadBridge side

Add inbound endpoint, e.g.:

`POST /v1/integrations/service-flow/job-status`

Behavior:

* verify HMAC signature
* validate payload
* find correct LeadBridge lead by external ID / mapping
* update LB status
* ensure follow-up scheduler and automation respect updated status on next cycle
* emit UI refresh/event notifications if applicable (for example SSE / live updates)

## Important business rules to think through

The plan must not just describe the happy path. It must explicitly cover these rules:

### 1. Source of truth

Define clear ownership:

* **Service Flow** should likely be the primary operational source for internal job progress/status
* **Yelp / Thumbtack** still matter for external/platform truth and discrepancy correction
* LeadBridge should not blindly overwrite statuses without rules

You must propose a practical authority model, for example:

* SF is authoritative for internal sales/job pipeline statuses
* platform sync is authoritative for platform-native states that SF cannot know directly
* discrepancy resolution logic decides whether to overwrite, ignore, or flag conflicts

### 2. Mapping between SF and LB objects

We need a robust mapping strategy between:

* Service Flow job / lead record
* LeadBridge lead record
* external platform lead/conversation/request identifiers

The plan must specify:

* which identifier should be canonical for cross-system status sync
* whether `externalRequestId` is enough
* whether we need an explicit mapping table
* how to handle legacy records with missing or inconsistent mapping

### 3. Conflict handling

We need explicit rules for cases like:

* SF marks as `scheduled`, but platform still looks open
* platform shows archived / closed, while SF still has active job
* duplicate or out-of-order events arrive
* the same status is sent multiple times
* status changed manually in LB, then overwritten by SF
* status changed in SF, but the mapped lead does not exist in LB

The plan should propose:

* idempotency strategy
* ordering strategy
* conflict resolution rules
* error logging / dead-letter or retry behavior
* whether some conflicts should only be flagged, not auto-fixed

### 4. Follow-up engine impact

This is critical.

The plan must explain exactly what happens to LeadBridge automation when a status update comes from SF:

* which statuses stop follow-ups immediately
* which statuses pause follow-ups
* which statuses are non-terminal and should continue
* whether status changes should unenroll existing sequences or only suppress next send
* what happens if the status later becomes active again

### 5. Platform sync role after this change

We still need periodic Yelp / Thumbtack sync.

The plan must define the new role of platform sync after SF → LB webhook exists:

* how often it should run
* what it checks
* whether it only checks discrepancies or still does full status refresh
* whether it updates LB only, or also writes corrective info back to SF
* whether it should create discrepancy logs/tasks instead of silently overwriting

### 6. Rollout safety

We need a rollout plan that minimizes risk.

Plan should include:

* feature flags
* logging / observability
* audit trail for inbound status updates
* replay/testing strategy
* staged rollout steps
* fallback behavior if webhook delivery fails

## Deliverables expected from this task

Prepare a plan that includes all of the following:

### A. Architecture overview

* event flow from SF → LB
* continued platform sync flow
* ownership boundaries between SF, LB, Yelp, Thumbtack

### B. Data model / mapping impact

* required schema changes in LB and/or SF
* any new mapping tables or event log tables
* status normalization strategy across systems

### C. API contract

* exact webhook endpoint proposal
* request payload shape
* authentication/signature format
* idempotency fields
* response codes
* retry expectations

### D. LeadBridge processing logic

* lookup logic for matched lead
* update rules
* no-op rules
* conflict rules
* automation/follow-up behavior

### E. Periodic discrepancy sync design

* cron frequency
* scope of sync
* discrepancy detection logic
* overwrite vs flag decisions
* repair flow between systems

### F. Observability

* logs
* metrics
* alerting
* audit history for status changes and sync corrections

### G. Rollout plan

* phased implementation order
* backward compatibility
* migration handling
* testing plan
* safe deployment strategy

## Constraints / preferences

* Prefer **webhooks over polling**
* Reuse existing HMAC webhook infrastructure where possible
* Keep extension/platform scraping only for:

  * historical import
  * initial sync
  * discrepancy audits / correction
* Do **not** assume Yelp/Thumbtack can be updated directly from SF in real time
* Design for eventual consistency, but reduce stale status lag as much as possible
* Avoid excessive polling load
* Preserve clear auditability of who/what changed a status:

  * Service Flow
  * platform sync
  * manual internal action
  * LeadBridge automation/internal logic

## Output format

Return the answer as a **pragmatic implementation plan**, not code.

Use this structure:

1. Recommended architecture
2. Source-of-truth rules
3. Status mapping model
4. Webhook contract
5. LeadBridge inbound processing flow
6. Platform discrepancy sync design
7. Follow-up / automation behavior
8. Schema + API changes
9. Risks / edge cases
10. Rollout plan
11. Open questions / decisions to confirm

## Important

Do not jump into implementation yet.
This task is only to produce the **plan for review and approval**.

