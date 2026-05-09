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

## Operator decision — 5-day soak waived (2026-05-09T03:00Z)

Operator elected to finish Phase 1 implementation today and waive the
originally-planned 5-day window 1 + 3-day window 2 schedule. Replacement
plan: accelerated validation since T+0 + immediate Task 3 deploy +
short observation window (2-4 hours) before final verdict.

**Explicit acknowledgement**: this reduces confidence from real
production observation. Phase 2 (SF v8.1) remains gated on the
reduced-soak GREEN verdict.

### Accelerated post-T+0 validation (window: T+0 to T+0+16min)

| Metric | Value | Verdict |
|---|---:|---|
| Gate BLOCK / re-engagement bypass | 0 | low traffic, expected |
| Gate classifier failed | 0 | GREEN |
| Yelp inbound webhook activity | 2 | healthy |
| writeStatus skipped (any reason) | 0 | GREEN |
| Sigcore cross-tenant rejects | 0 | GREEN |
| Crash patterns LB+Sigcore | 0 | GREEN |
| Donna fingerprint cum | 0 | GREEN |
| Donna fingerprint NEW since T+0 | 0 | GREEN |
| Active enrollment dupes | 0 | GREEN |
| Yelp dupe pair candidates | 0 | GREEN |

Verdict: **GREEN**. Cleared Task 3 ship.

### Task 3 production deploy (2026-05-09T03:05Z)

- Commit: `d4604f5` (terminal_defer intent + gate change)
- Staging deploy `ed1efffa` SUCCESS at 02:57:30Z, Nest started 02:59:10Z, 0 crashes.
- Prod deploy `a0ca18ea` SUCCESS, Nest started 03:05:19Z, 0 crashes.
- Smoke: 66/66 gate + equivalence + classifier tests pass; scheduler ticking healthily ("Processing 7 claimed enrollments" at 03:06:02Z) with new audit-log writes.
- 0 prisma errors, 0 follow-up scheduler errors, 0 unrecognized-intent errors (terminal_defer is in coerceIntent allowlist).

### Reduced observation window (2-4 hours from 03:05Z) — SUPERSEDED 2026-05-09T03:15Z

Operator changed direction before the 2-4hr window expired: with all
listed Phase 1 scope items complete, run the verdict immediately and
treat that as the "Phase 1 implementation complete" stamp. The actual
soak (single window on the final completed system) starts AFTER this
verdict, replacing the original two-window structure entirely.

### Phase 1 implementation-complete verdict (2026-05-09T03:15Z)

Window: Task 3 prod deploy (03:05Z) → verdict run (03:15Z) = 10 min.

| Metric | Hits/Value | Verdict |
|---|---:|---|
| 1a. Gate BLOCK / re-engagement bypass | 0 | n/a (no AI traffic in window) |
| 1b. Classifier failed (fail-open) | 0 | GREEN |
| 1c. Yelp Step 1 lookups | 1 | healthy |
| 1d. writeStatus skipped (any reason) | 0 | GREEN |
| 1e. Sigcore cross-tenant rejects | 0 | GREEN |
| 1f. Crash patterns LB+Sigcore | 0 | GREEN |
| terminal_defer BLOCK hits | 0 | n/a (no terminal_defer messages in window) |
| `unrecognized intent` errors | 0 | GREEN — coerceIntent allowlist accepts terminal_defer |
| classifier intent= log lines | 0 | low traffic, expected |
| `prisma:error` / FollowUp ERROR | 0 | GREEN |
| 2a. Donna fingerprint cumulative | 0 | GREEN |
| 2b. Donna fingerprint NEW since 03:05Z | 0 | GREEN |
| 2c. Active enrollment dupes | 0 | GREEN |
| 2d. status_changed audit rows since 03:05Z | 0 | low traffic |
| 2e. Yelp dupe pair candidates | 0 | GREEN |
| `follow_up_enrollment_audit_log` rows | 0 | low traffic; table reachable, no errors |

**Verdict: 🟢 GREEN.** All metrics clean.

**Caveats acknowledged:**
- 10-min window with low-overnight-UTC traffic means several metrics (terminal_defer hits, classifier traffic, audit log writes, status changes) had nothing to measure. Their zero values prove "no errors" but do NOT prove "code path exercised under real load". The final soak (next section) is what closes that confidence gap.
- Reduced-soak waiver from the operator earlier in this session stands.

## Phase 1 implementation: COMPLETE (with reduced-confidence caveat)

Verified-complete scope:

| Item | Commit / Receipt | State |
|---|---|---|
| Fix B — Yelp upsert update-branch status revert | LB `3793a29` → prod `351936ad` | shipped + live-verified by Donna webhook at 00:39Z |
| Fix A — Sigcore cross-tenant fromNumber guard | Sigcore `25f35010` → prod `63274af2` | shipped, 0 rejections (no impersonation attempts) |
| Fix C — Sigcore OP tenant-disconnect webhook cleanup | Sigcore `260a57a9` → prod `7d7794de` | shipped (structural; current prod has zero IDs to clean) |
| B3 — Donna + Devi heal | audit log `d73ebf52`, `d11bb6a2` | both rows healed; cumulative fingerprint 0 |
| B1 — Yelp message dedup | `audit-yelp-message-duplicates.js --merge --execute` | 30 stamped, 31 deleted; 0 pairs remain |
| Task 4 — enrollment audit log + idempotency | LB `92dfe93` → prod `aa0a1b70`, migration `20260509000000` applied | shipped, table reachable, 0 errors |
| Task 3 — terminal_defer intent + gate change | LB `d4604f5` → prod `a0ca18ea` | shipped, 0 unrecognized-intent errors, 920/920 unit tests + 66/66 gate-equivalence tests pass |
| 0 active enrollment dupes | A1 verification + ongoing | GREEN |
| 0 Yelp message dupe pairs | B1 + post-B1 verification | GREEN |
| 0 partial-state Donna/Devi fingerprints | B3 + cumulative count | GREEN |
| Baseline metrics clean | Tier A + accelerated validation | GREEN |

---

## Final soak (single window, on completed Phase 1 state)

**T+0 (final): 2026-05-09T03:15Z** (reset from the original 02:40Z stamp).

### Length: 5 days
T+5 verdict due **2026-05-14T03:15Z**. Same length as the originally-planned window 1; long enough to observe meaningful production traffic across:
  - At least one weekend/weekday cycle
  - Multiple Yelp + Thumbtack inbound batches per tenant
  - Several follow-up scheduler ticks per minute × 5 days × 60 min/hr × 24 hr ≈ 432,000 ticks
  - Realistic distribution of customer intents (engaged, asking, deferring, terminal_defer, agreed, opt_out, hired_elsewhere, completed)

### Daily checkpoints
Same procedure as `PHASE_1_SOAK_PLAYBOOK.md` §"Daily check" — 6 Loki queries + 5 DB queries — but additionally include:
- `block_terminal terminal_defer` count (must show ≥1 hit by T+3 to validate the new intent class is being returned in real traffic; absence by T+3 is YELLOW signal that the prompt change isn't surfacing the intent)
- `follow_up_enrollment_audit_log` row count (must grow each day; absence is YELLOW signal that audit-log writes aren't reaching the table)
- `re-engagement bypass` vs `BLOCK terminal_defer` ratio on `customer_deferred` triggerState (validates the bypass-exclusion logic)

### Thresholds
Inherits `PHASE_1_SOAK_PLAYBOOK.md` §"Thresholds" GREEN/YELLOW/RED bands plus the two new ones above.

### T+5 verdict (2026-05-14T03:15Z)
- **GREEN** → Phase 1 final-soak ACCEPTED. v8.1 unblocks for separate operator decision.
- **YELLOW** → root-cause + decide: extend, patch, or accept with caveat.
- **RED** → patch or rollback responsible commit; reset clock.

### Daily checkpoint table

| Day | Date (UTC) | Gate decisions | classifier_failed % | terminal_defer hits | Donna +24h | partial-state cum | dupe enrollments | Yelp dupes | cross-tenant rejects | crashes | audit rows cum | verdict |
|-----|-----------|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|---------|
| 0   | 2026-05-09 | (baseline) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **GREEN — final T+0 stamped** |
| 1   | 2026-05-10 | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| 2   | 2026-05-11 | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| 3   | 2026-05-12 | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| 4   | 2026-05-13 | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| 5   | 2026-05-14 | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | T+5 verdict |

## Anomalies

(append-only; record any signal that requires investigation, regardless of severity)

- 2026-05-09T02:32Z — auto-migrate did not apply `20260509000000_add_followup_enrollment_audit_log` on staging boot despite `prisma` being in `dependencies`. Manual `npx prisma migrate deploy` from local applied it cleanly at 02:35:38Z. Production deploy 4 min later saw the migration as already-applied and booted clean. **Note**: this is a pre-existing infra issue documented in `reference_railway_migrations.md` (memory updated 2026-05-09); it is NOT a Phase 1 gate or sync regression. Workaround stands: run manual migration apply after every PR with a Prisma migration. Root-cause investigation queued separately.
