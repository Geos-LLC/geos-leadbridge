-- Split the Instant Reply biz-hours gate from the Instant Text gate. Up to
-- this migration both UI checkboxes (Automation → Respond → Instant Reply
-- and Instant Text) wrote to the single `first_msg_during_business_hours`
-- column, which only gated customer-facing SMS notification rules — so the
-- Instant Reply (platform new_lead automation) checkbox was a UI alias with
-- no backend effect.
--
-- New column tracks the Instant Reply gate independently. Default is FALSE
-- — Instant Reply sends 24/7 unless the tenant explicitly opts in to the
-- biz-hours restriction. This also preserves prior runtime behavior: before
-- this column existed, Instant Reply (the platform new_lead automation) had
-- no biz-hours gating at all, regardless of what the UI checkbox showed.

ALTER TABLE "saved_accounts"
  ADD COLUMN "instant_reply_during_business_hours" BOOLEAN NOT NULL DEFAULT false;
