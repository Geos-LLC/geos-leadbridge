-- Parsed metadata for the user's business website. Populated by the
-- onboarding wizard's Business step when verifyWebsite finds a
-- reachable URL: title, description, phone, og:image, etc. Used later
-- to pre-fill AI Knowledge / Settings without re-parsing.
--
-- Nullable; existing rows need no backfill — null means "we haven't
-- parsed (or the user hasn't connected) a website yet".

ALTER TABLE "users"
  ADD COLUMN "websiteMetadataJson" JSONB;
