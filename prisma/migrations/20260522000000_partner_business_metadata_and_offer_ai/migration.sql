-- Partner Network: cache website verification metadata on the business row.
-- Populated when the admin clicks "Verify" on the business form. Read by the
-- AI relationship-copy generator so it can ground name/offer suggestions in
-- the real site's title + description, not just the business name.

ALTER TABLE "partner_businesses"
ADD COLUMN "websiteMetadataJson" TEXT;
