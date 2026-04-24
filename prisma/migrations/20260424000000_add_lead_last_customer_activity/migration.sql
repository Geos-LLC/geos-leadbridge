-- Phase A: persistence & signal integrity for Yelp inbound messages.
-- Provider-agnostic lead-level marker read by the follow-up scheduler self-heal
-- to stop enrollments even when a provider failed to write a Message row.

ALTER TABLE "leads" ADD COLUMN "lastCustomerActivityAt" TIMESTAMP(3);

CREATE INDEX "leads_lastCustomerActivityAt_idx" ON "leads"("lastCustomerActivityAt");
