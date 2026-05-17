-- Business website URL on User. Collected by the 8-step onboarding
-- wizard's Business step (PR 2) and fed into the AI prompt context
-- (parser stub today, real website analysis later).
--
-- Nullable + free-text — we don't enforce URL format because users may
-- legitimately enter values like "myco.com", "https://myco.com", or
-- nothing at all (the wizard has an explicit "I don't have a website"
-- skip path).

ALTER TABLE "users"
  ADD COLUMN "website" TEXT;
