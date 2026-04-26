-- Drop pool + BYO/OpenPhone phone routing now that code has been stripped
-- (PRs #104 and #105 removed all readers/writers of these tables and columns).
-- Production audit before: phone_pool=0 rows, phone_pool_assignments=0 rows,
-- notification_settings.sigcoreProvider='openphone'=0 rows. No data loss risk.

-- Drop assignment join table first (FKs to phone_pool and users)
DROP TABLE IF EXISTS "phone_pool_assignments";

-- Drop pool table (was joined from users via assignedToUserId with ON DELETE SET NULL)
DROP TABLE IF EXISTS "phone_pool";

-- Drop enum once all its consumers are gone
DROP TYPE IF EXISTS "PhonePoolStatus";

-- Drop dead BYO columns on notification_settings.
-- sigcoreFromPhone (column callioFromPhone): was BYO-configured "send from" phone;
--   dedicated numbers resolve via TenantPhoneNumber + resolveBotPhone.
-- sigcoreProvider: was 'openphone' | 'twilio' routing flag; now always Sigcore/Twilio
--   via dedicated number.
-- sigcoreWebhookId (column callioWebhookId): was delivery-status webhook subscription
--   ID, only ever written by the OpenPhone-specific connectSigcore endpoint that no
--   longer exists. Note: CallConnectSettings.sigcoreWebhookId is a DIFFERENT column
--   on a DIFFERENT table — it's live (call-connect event webhook) and kept.
ALTER TABLE "notification_settings" DROP COLUMN IF EXISTS "callioFromPhone";
ALTER TABLE "notification_settings" DROP COLUMN IF EXISTS "sigcoreProvider";
ALTER TABLE "notification_settings" DROP COLUMN IF EXISTS "callioWebhookId";
