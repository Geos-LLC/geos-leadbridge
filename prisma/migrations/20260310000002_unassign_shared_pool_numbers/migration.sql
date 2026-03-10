-- Unassign all pool numbers that are currently shared across multiple tenants.
-- Enforces the 1-number-1-tenant rule by clearing multi-tenant pool assignments
-- and resetting those phones back to AVAILABLE.

-- 1. Delete all assignments for pool phones that have more than 1 assignment
DELETE FROM "phone_pool_assignments"
WHERE "phonePoolId" IN (
  SELECT "phonePoolId"
  FROM "phone_pool_assignments"
  GROUP BY "phonePoolId"
  HAVING COUNT(*) > 1
);

-- 2. Reset those phones back to AVAILABLE
UPDATE "phone_pool"
SET "status" = 'AVAILABLE'
WHERE "id" IN (
  SELECT pp."id"
  FROM "phone_pool" pp
  LEFT JOIN "phone_pool_assignments" ppa ON ppa."phonePoolId" = pp."id"
  WHERE pp."status" = 'ASSIGNED'
    AND ppa."id" IS NULL
);
