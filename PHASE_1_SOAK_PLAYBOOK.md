# Phase 1 Final Soak — Playbook

**Status**: draft, awaiting sign-off before window 1 starts.
**Owner**: same operator running the soak.
**Window 1 duration**: 5 days (current Phase 1 + Fix B + Task 4 baseline).
**Window 2 duration**: 3 days (post-Task-3, terminal_defer behavior).

---

## What this soak validates

End-to-end correctness of the follow-up gate + status-write pipeline under live production traffic, across:

1. **Phase 1 Task 1+2** — `FollowUpGateService` is the sole decision-maker on both scheduler and preview paths. Verified by `follow-up-gate-equivalence.spec.ts` at unit level; soak validates under prod data shapes.
2. **Phase 1 Task 6+7** — historical opt_out/completed/hired backfill via `audit-missed-optouts.ts` APPLY mode left no orphaned partial-state leads.
3. **Fix B (commit `3793a29`)** — Yelp inbound webhook upsert no longer silently reverts canonical `lead.status`.
4. **Fix A (Sigcore commit `25f35010`)** — cross-tenant `fromNumber` impersonation closed.
5. **Fix C (Sigcore commit `260a57a9`)** — tenant-scoped OpenPhone disconnect cleans up webhooks (forward-compat; current prod has zero IDs to clean).

Soak does NOT validate:
- v8.1 SF projection reset (paused).
- Tasks 3 (terminal_defer intent class) — that's window 2's scope.

---

## Pre-soak baseline (T-0)

Collected 2026-05-09T~02:15Z immediately after Tier B execution.

| Metric | Value | Source |
|---|---|---|
| Donna-fingerprint partial-state leads | **0** | LB Prisma `lead.findMany({ lostReason: not null, status: notIn TERMINAL })` |
| Yelp duplicate message pairs | **0** | `scripts/audit-yelp-message-duplicates.js` (dry-run) |
| Active FollowUpEnrollment dupes per conversation | **0** | `scripts/cleanup-duplicate-enrollments.js` (dry-run) |
| Sigcore TPN integrity (NULL or orphan tenant_id) | **0** | A3 query |
| Sigcore communication_conversations NULL tenant_id (last 30d) | **75** | A4 query — historical, not blocking |
| LB cross-tenant `fromNumber` rejections (since Fix A deploy) | **0** | Loki `cross-tenant fromNumber rejected` |
| Production deploys clean since Fix A/B/C | yes | Loki `ExceptionHandler|FATAL|Cannot find` |

**Baseline established. Any drift from this baseline during soak is a signal worth investigating.**

---

## Daily check (run once per 24h)

Each daily run produces one row in the soak log. The operator is expected to spend ~10 min interpreting; longer only if a metric breaches threshold.

### 1. Loki query bundle

Run all six queries against `service_name="leadbridge-api"` for the last 24 hours:

```logql
# 1a. Gate decision distribution by action
{service_name="leadbridge-api"} |~ "\\[FollowUpGate\\] (BLOCK|re-engagement bypass)|FollowUpGate.*passDecision"
# count grouped by action; expect proceed/pass_low_confidence majority, block_terminal small steady stream

# 1b. Gate `pass_classifier_failed` rate (OpenAI / network health)
{service_name="leadbridge-api"} |~ "Classifier threw — passing through"
# threshold: <5% of total gate evaluations; sustained >5% = YELLOW

# 1c. Yelp upsert webhook activity vs status writes
{service_name="leadbridge-api"} |~ "\\[Yelp\\] Step 1: Finding saved account"
# baseline: matches normal Yelp inbound rate. Anomaly if 10x spike or 0 for >12h

# 1d. writeStatus skip reasons
{service_name="leadbridge-api"} |~ "\\[LeadStatus\\].*result=skipped"
# track skip_reason distribution; new categories or >10x baseline = investigate

# 1e. Cross-tenant fromNumber rejections (should be 0 if no test traffic)
{service_name="sigcore-api"} |~ "cross-tenant fromNumber rejected"
# any non-zero = either a real impersonation attempt OR a tenant whose API key
# was issued without their phone reassigned. Investigate via tpn=<id>.

# 1f. Sigcore prod crash patterns (regression check)
{service_name=~"sigcore-api|leadbridge-api"} |~ "ExceptionHandler|FATAL|Cannot find|Nest can't resolve"
# expected: 0. Any hit blocks the soak.
```

### 2. DB query bundle

Run from any environment with `DATABASE_URL=$LB_DIRECT_URL`:

```javascript
// daily-soak-counts.js — run with `node` and ./generated/prisma client
const TERMINAL = ['lost', 'booked', 'completed', 'archived', 'hired', 'cancelled', 'done', 'scheduled'];
const since = new Date(Date.now() - 24 * 3600 * 1000);

// 2a. Donna fingerprint — must stay 0
const partial = await prisma.lead.count({
  where: { lostReason: { not: null }, status: { notIn: TERMINAL } },
});

// 2b. Donna fingerprint NEW since last 24h — should be 0; non-zero = Fix B regression
const partialRecent = await prisma.lead.count({
  where: { lostReason: { not: null }, status: { notIn: TERMINAL }, updatedAt: { gt: since } },
});

// 2c. Active enrollment dupes — must stay 0
const dupeEnrollments = await prisma.$queryRaw`
  SELECT COUNT(*)::int AS n FROM (
    SELECT "conversationId" FROM "follow_up_enrollments" WHERE "status" = 'active' GROUP BY "conversationId" HAVING COUNT(*) > 1
  ) x`;

// 2d. status_changed audit rows in last 24h, by source
const audits = await prisma.leadStatusAuditLog.groupBy({
  by: ['source'],
  where: { createdAt: { gt: since }, activityType: 'status_changed' },
  _count: true,
});

// 2e. Yelp dupe pairs (run audit-yelp-message-duplicates.js dry-run); expect 0
//     any non-zero = the create-branch / persistence path regressed
```

### 3. Spot-check Yelp upsert post-fix behavior

Once per day, pick 5 most-recent Yelp lead `updatedAt` rows. For each, verify the lead.status was NOT changed by a Yelp webhook:

```javascript
const recent = await prisma.lead.findMany({
  where: { platform: 'yelp', updatedAt: { gt: since } },
  orderBy: { updatedAt: 'desc' },
  take: 5,
  select: { id: true, customerName: true, status: true, statusUpdatedAt: true, updatedAt: true },
});

for (const l of recent) {
  // If lead.updatedAt is recent (last 24h) but statusUpdatedAt is NOT recent,
  // that's the post-fix expected pattern — webhook touched non-status fields only.
  // If statusUpdatedAt is also recent, find the audit row and confirm its source
  // is NOT 'platform_sync' from a Yelp webhook event.
  const recentAudit = await prisma.leadStatusAuditLog.findFirst({
    where: { leadId: l.id, createdAt: { gt: since } },
    orderBy: { createdAt: 'desc' },
  });
  // Pass: either no audit row OR audit row source is 'manual' / 'lb_automation' / non-Yelp
}
```

This is the targeted Fix B regression check.

---

## Daily checkpoint format

Append one row per day to a soak log markdown file (`PHASE_1_SOAK_LOG.md` or memory entry):

```
| Day | Date (UTC) | Gate decisions | classifier_failed % | Donna +24h | dupe leads (cum) | dupe enrollments | Yelp dupe pairs | cross-tenant rejections | crashes | verdict |
|-----|-----------|----------------|---------------------|------------|------------------|------------------|------------------|-------------------------|---------|---------|
| 0   | 2026-05-09 | (baseline) | -- | 0 | 0 | 0 | 0 | 0 | 0 | GREEN |
| 1   | 2026-05-10 | TBD | TBD | 0 | 0 | 0 | 0 | 0 | 0 | TBD |
| ... | | | | | | | | | | |
| 5   | 2026-05-14 | TBD | TBD | 0 | 0 | 0 | 0 | 0 | 0 | window-1 verdict |
```

Plus a free-text "anomalies / commentary" line per day for anything that doesn't fit the table.

---

## Thresholds

| Metric | GREEN | YELLOW | RED |
|---|---|---|---|
| Donna fingerprint cum. count | 0 | 1-2 (with explainable cause) | ≥3 (Fix B regression) |
| Donna fingerprint new in last 24h | 0 | 1 | ≥2 |
| Active enrollment dupes | 0 | — | ≥1 (partial-unique-index regression) |
| Yelp dupe pairs | 0 | 1-5 | ≥6 (persistence path regression) |
| cross-tenant rejections | 0 | 1-2 (test traffic) | ≥3 (real impersonation) |
| classifier_failed % | <2% | 2-5% | ≥5% sustained 6h+ |
| `block_terminal` count for 24h | 1-50 | 0 (suspicious) OR ≥200 (mass event) | — |
| crashes (ExceptionHandler etc.) | 0 | 1-2 (transient) | ≥3 OR repeated same trace |

---

## Verdict criteria

### Window 1 (T+5)

- **GREEN** → all metrics within GREEN bands every day. Ship Task 3, start window 2.
- **YELLOW** → at least one metric in YELLOW. Investigate root cause. Decide:
  - If root cause is unrelated to Phase 1 (e.g., OpenAI outage degrading classifier_failed %): note + continue.
  - If root cause is a Phase 1 regression: extend window 1 by 2 days after fix lands.
- **RED** → roll back the responsible commit, re-baseline, re-start the clock.

### Window 2 (T+3 after Task 3 ships)

Same thresholds, but additionally:
- Verify gate decisions for `terminal_defer` intent appear (≥1 occurrence per ~50 deferring-class messages).
- Verify enrollments terminated by `terminal_defer` carry the new `stop_and_lost` side effect (not `stop_only`).
- Verify enrollments terminated by `deferring` (bounded) still get `stop_only`.

### Final verdict (T+8 from now)

- GREEN window 1 + GREEN window 2 → Phase 1 complete. Unblocks v8.1 readiness reassessment.
- Any combination producing extended/RED → root cause + remediate before declaring Phase 1 done.

---

## Anti-pattern guardrails

- **DO NOT** widen GREEN bands to make a soak day pass. If the threshold breaches, document it.
- **DO NOT** restart the soak clock just because the operator missed a daily check — the metrics are still measurable retroactively from Loki + DB.
- **DO NOT** mix v8.1 work into the soak window. v8.1 stays paused until Phase 1 final verdict GREEN.
- **DO NOT** onboard new tenants during the soak. New tenants would change the baseline (gate decision distribution, conversation counts).
- **DO** re-run the dedup watchers (Yelp messages, enrollments) on day 3 — partial regression risk.

---

## Sign-off / activation

The soak is considered active starting on the day the operator stamps "T+0" in the soak log AND has run the baseline metrics defined above. Until then, this playbook is a draft.
