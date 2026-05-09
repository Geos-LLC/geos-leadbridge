# Phase 1 Final Soak — Log

Per `PHASE_1_SOAK_PLAYBOOK.md`. Update once per 24h.

## Window 1 — 5 days, current Phase 1 + Fix B baseline

| Day | Date (UTC) | Gate decisions (24h) | classifier_failed % | Donna +24h | partial-state cum | dupe enrollments | Yelp dupe pairs | cross-tenant rejections | crashes | verdict |
|-----|-----------|-----|-----|-----|-----|-----|-----|-----|-----|---------|
| 0   | 2026-05-09 | (baseline) | n/a | 0 | 0 | 0 | 0 | 0 | 0 | **GREEN — baseline stamped** |

### T+0 stamp — 2026-05-09T02:40Z

Window 1 is **active** as of this stamp.

Production state at T+0:

| Metric | Value | Source |
|---|---|---|
| LB prod deploy | `aa0a1b70` SUCCESS | Railway |
| LB prod boot | 2026-05-09T02:39:30Z (Nest started clean) | Loki |
| LB main commits ahead of pre-soak `3793a29` | `5078d8c` (playbook+B3) + `92dfe93` (Task 4) | git |
| Migration `20260509000000_add_followup_enrollment_audit_log` | applied at 02:35:38Z (manual; auto-migrate still broken) | _prisma_migrations |
| Donna fingerprint partial-state count | 0 | `lead.findMany({ lostReason: not null, status: notIn TERMINAL })` |
| Yelp duplicate message pairs | 0 | `audit-yelp-message-duplicates.js` dry-run |
| Active enrollment dupes per conversation | 0 | `cleanup-duplicate-enrollments.js` dry-run |
| Sigcore TPN integrity (NULL or orphan tenant_id) | 0 | A3 query |
| Cross-tenant `fromNumber` rejections (since Fix A deploy) | 0 | Loki |
| Production crash patterns (last 30 min) | 0 | Loki |

**Window 1 closes**: 2026-05-14T02:40Z. T+5 verdict due then.

### Daily checkpoints

(populate one row per 24h per playbook §"Daily check")

| Day | Date (UTC) | Notes |
|-----|-----------|-------|
| 1   | 2026-05-10 | TBD |
| 2   | 2026-05-11 | TBD |
| 3   | 2026-05-12 | TBD |
| 4   | 2026-05-13 | TBD |
| 5   | 2026-05-14 | T+5 verdict due |

## Window 2 — 3 days, post-Task-3 terminal_defer behavior

(starts after Task 3 ships and Window 1 verdict is GREEN)

| Day | Date (UTC) | Notes |
|-----|-----------|-------|
| 1   | TBD | |
| 2   | TBD | |
| 3   | TBD | T+3 verdict due |

## Final verdict

(populated at T+8 from Window 1 start, conditional on both windows GREEN)

- **Window 1**: TBD
- **Window 2**: TBD
- **Final**: TBD

## Anomalies

(append-only; record any signal that requires investigation, regardless of severity)

- 2026-05-09T02:32Z — auto-migrate did not apply `20260509000000_add_followup_enrollment_audit_log` on staging boot despite `prisma` being in `dependencies`. Manual `npx prisma migrate deploy` from local applied it cleanly at 02:35:38Z. Production deploy 4 min later saw the migration as already-applied and booted clean. **Note**: this is a pre-existing infra issue documented in `reference_railway_migrations.md` (memory updated 2026-05-09); it is NOT a Phase 1 gate or sync regression. Workaround stands: run manual migration apply after every PR with a Prisma migration. Root-cause investigation queued separately.
