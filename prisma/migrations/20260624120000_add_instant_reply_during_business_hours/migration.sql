-- Split the Instant Reply biz-hours gate from the Instant Text gate. Up to
-- this migration both UI checkboxes (Automation → Respond → Instant Reply
-- and Instant Text) wrote to the single `first_msg_during_business_hours`
-- column, which only gated customer-facing SMS notification rules — so the
-- Instant Reply (platform new_lead automation) checkbox was a UI alias with
-- no backend effect.
--
-- New column tracks the Instant Reply gate independently. Existing rows
-- copy their current `first_msg_during_business_hours` value so behavior is
-- preserved for tenants whose Instant Text setting also matches what they
-- want for Instant Reply.

ALTER TABLE "SavedAccount"
  ADD COLUMN "instant_reply_during_business_hours" BOOLEAN NOT NULL DEFAULT true;

UPDATE "SavedAccount"
  SET "instant_reply_during_business_hours" = "first_msg_during_business_hours";
