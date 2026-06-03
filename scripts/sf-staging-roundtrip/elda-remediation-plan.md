# Elda Wells — remediation plan (doc only, do not execute yet)

**Lead:** `23e6827b-c188-4c81-b68a-54ad18e05f3e`
**Customer:** Elda
**User:** (Spotless / `c3d14499-…`)
**Thread:** `b36ab636-660b-474d-a253-49d8555a412c`

## Current state (2026-06-02, prod)

```
status:           lost
lostReason:       hired_someone
reengageAt:       2026-06-11T23:22:10.779Z
statusSource:     lb_automation
statusUpdatedAt:  2026-05-21T23:22:11.179Z
sfJobId:          null              ← not SF-linked
syncStatus:       null
```

## What actually happened (audit trail + thread)

| Time (UTC) | Event |
|---|---|
| 2026-05-21 23:17:29Z | Audit: `new → engaged`, reason=`customer_replied` (LB automation) |
| 2026-05-21 23:20:54Z | **Customer**: "ok...does that include fans? I would like those cleaned too. If you could come tomorrow around 1pm.. does that work for [you?]" |
| 2026-05-21 23:21:14Z | **AI**: "The team will confirm if fans can be included in the cleaning. Got it — I'll check our timing for tomorrow around 1 PM and confirm shortly." ← **holding message** |
| 2026-05-21 23:22:01Z | **Customer**: "Ok." ← bare acknowledgement |
| 2026-05-21 23:22:11Z | **Audit: `engaged → lost`, reason=`hired_someone`** ← misclassification |
| 2026-05-22 00:07:21Z | **Customer**: "Can you confirm?" ← clearly NOT hired anyone |
| 2026-05-22 00:51:19Z | Operator: "Hi Elda! Please share your phone number..." |
| 2026-05-22 00:52:57Z | **Customer**: shared phone `786-479-4330` "thank you" ← engaged, willing to be called |

The transition fired 10 seconds after Elda said "Ok." in response to the AI's holding message. The follow-up messages prove she had not hired anyone.

## Restoration

Since `sfJobId=null`, there is no SF truth to defer to. Restoration is based on LB's own conversation context: the customer is genuinely engaged.

Target state:
```
status:        engaged    ← restore the pre-misclassification state
lostReason:    null       ← clear
reengageAt:    null       ← clear (was scheduled by the misclassification)
statusSource:  lb_admin   ← attribute to operator correction
```

Plus an audit row explaining the correction.

## Suggested admin endpoint payload (after classifier ship + verify)

The right tool is `LeadStatusService.writeStatus` with `adminOverride: true` (already supports the sf_managed bypass; the same flag would let this correction skip the same path even though sfJobId is null here — it's just hygienic):

```ts
await leadStatusService.writeStatus({
  leadId: '23e6827b-c188-4c81-b68a-54ad18e05f3e',
  newStatus: 'engaged',
  source: 'manual',           // operator-driven; not 'lb_automation'
  occurredAt: new Date(),
  actorType: 'admin',
  actorId: '<operator user id>',
  actorName: 'classifier_correction',
  reason: 'classifier_misclassification:bare_ack_after_holding (Elda Wells regression, fix shipped 2026-06-03)',
  reengageAt: null,           // clear the misclassified re-engage window
  lostReason: null,           // implicitly cleared by the writeStatus lost→non-lost transition logic
  adminOverride: true,        // hygienic; no sf_connection here, but mark this as authorized
});
```

`LeadStatusService.writeStatus` will:
1. Pass `hard_terminal` reactivation only because the lostReason clearing logic handles transitions OUT of lost — confirmed in the existing transitions test suite.
2. Write the audit row with the documented reason.
3. Emit the `lead.status.applied` event for SSE/UI refresh.

## Pre-conditions before running this remediation

1. **Classifier fix is deployed and verified.** Without it, the next "Ok." from Elda would re-trigger the same misclassification.
2. **Operator confirms via the thread** that Elda is still a candidate (she was, as of the messages quoted above).
3. **Apply via an admin endpoint with support-grant**, NOT a raw DB write — preserves audit + event semantics.

## Why this remediation is one-off, not bulk

- The user explicitly directed: "Do not bulk-modify other leads until classifier patch is shipped and verified."
- A bulk job to find all `engaged → lost (hired_someone)` audit rows fired immediately after a holding-shape AI message is feasible but risky — false positives (real opt-out) would resurface dead leads.
- After the classifier fix has soaked, a separate audit can identify other false-positive candidates (search criteria: lead.statusUpdatedAt > date, lostReason='hired_someone', last preceding AI message contains holding language). Each surfaced candidate gets manual review before restoration.
