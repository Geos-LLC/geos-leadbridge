-- Deduplicate message_templates: for each (userId, name) group keep the oldest,
-- re-point any rules that reference duplicates, then delete duplicates.
-- Finally add a unique constraint to prevent recurrence.

-- 1. Re-point automation_rules to the oldest duplicate
UPDATE "automation_rules" ar
SET "templateId" = keeper."id"
FROM (
  SELECT DISTINCT ON ("userId", "name") "id", "userId", "name"
  FROM "message_templates"
  ORDER BY "userId", "name", "createdAt" ASC
) AS keeper
JOIN "message_templates" dup
  ON dup."userId" = keeper."userId"
  AND dup."name" = keeper."name"
  AND dup."id" <> keeper."id"
WHERE ar."templateId" = dup."id";

-- 2. Re-point notification_rules to the oldest duplicate
UPDATE "notification_rules" nr
SET "templateId" = keeper."id"
FROM (
  SELECT DISTINCT ON ("userId", "name") "id", "userId", "name"
  FROM "message_templates"
  ORDER BY "userId", "name", "createdAt" ASC
) AS keeper
JOIN "message_templates" dup
  ON dup."userId" = keeper."userId"
  AND dup."name" = keeper."name"
  AND dup."id" <> keeper."id"
WHERE nr."templateId" = dup."id";

-- 3. Delete duplicate templates (keep the oldest per userId+name)
DELETE FROM "message_templates"
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id",
           ROW_NUMBER() OVER (PARTITION BY "userId", "name" ORDER BY "createdAt" ASC) AS rn
    FROM "message_templates"
  ) ranked
  WHERE rn > 1
);

-- 4. Add unique constraint to prevent future duplicates
ALTER TABLE "message_templates"
ADD CONSTRAINT "message_templates_userId_name_key" UNIQUE ("userId", "name");
