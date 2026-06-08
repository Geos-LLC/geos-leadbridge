-- Status simplification (2026-06-08)
--
-- Collapse the canonical Lead.status vocabulary:
--   contacted → engaged   (both are mid-funnel "active" states)
--   scheduled → booked    (both are won-side terminals — LB no longer
--                          distinguishes "scheduled but not yet booked"
--                          from "booked" since neither platform reliably
--                          emits the distinction)
--
-- See plans/status-simplification-2026-06-08.md for the full rationale.
--
-- ## Safety / idempotency
--
-- Both UPDATEs are no-ops on re-run — once the rows have been moved to
-- engaged / booked, the WHERE clause matches zero rows. The migration is
-- thus safe to re-run, and Prisma's _prisma_migrations dedup table will
-- skip it on subsequent deploys anyway.
--
-- ## Production snapshot before migration (queried 2026-06-08)
--
--   status      | count
--   ------------+------
--   lost        | 1151
--   new         |  758
--   completed   |  260
--   contacted   |   88  <-- migrating
--   engaged     |   73
--   cancelled   |   42
--   booked      |   11
--   scheduled   |    4  <-- migrating
--
-- Expected after-migration counts:
--   contacted   | 0       (88 rows merged into engaged → engaged = 161)
--   scheduled   | 0       (4  rows merged into booked  → booked  = 15)
--   Every other status: unchanged.

BEGIN;

UPDATE leads
   SET status = 'engaged'
 WHERE status = 'contacted';

UPDATE leads
   SET status = 'booked'
 WHERE status = 'scheduled';

COMMIT;
