# LeadBridge Database Structure

> Generated from `prisma/schema.prisma`. Column names reflect the **actual DB column names** (accounting for `@map` overrides).

---

## Enums

| Enum | Values |
|------|--------|
| `UserRole` | `USER`, `ADMIN` |
| `CallConnectMode` | `AGENT_FIRST`, `PARALLEL` |
| `CallConnectStatus` | `CREATED`, `CALLING_AGENT`, `AGENT_ANSWERED`, `AGENT_ACCEPTED`, `CALLING_LEAD`, `BRIDGED`, `VOICEMAIL_DROP`, `ENDED`, `FAILED`, `CANCELED`, `RINGING_AGENT` *(legacy)*, `RINGING_LEAD` *(legacy)*, `CANCELLED` *(legacy)* |
| `SubscriptionTier` | `STARTER`, `PRO`, `ENTERPRISE` |
| `SubscriptionStatus` | `ACTIVE`, `PAST_DUE`, `CANCELLED`, `TRIALING`, `INCOMPLETE` |
| `PhonePoolStatus` | `AVAILABLE`, `ASSIGNED`, `RESERVED`, `RELEASED` |
| `TenantPhoneStatus` | `ACTIVE`, `GRACE_PERIOD`, `RELEASED` |

---

## Tables

### `users`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `email` | string UNIQUE | |
| `name` | string? | |
| `password` | string? | Hashed |
| `createdAt` | datetime | |
| `updatedAt` | datetime | |
| `role` | UserRole | default `USER` |
| `stripeCustomerId` | string? UNIQUE | |
| `stripeSubscriptionId` | string? UNIQUE | |
| `subscriptionTier` | SubscriptionTier? | |
| `subscriptionStatus` | SubscriptionStatus? | |
| `subscriptionPeriodEnd` | datetime? | |
| `cancelAtPeriodEnd` | bool | default false |
| `hasOwnNumber` | bool | default false |
| `trialStartDate` | datetime? | |
| `trialEndDate` | datetime? | |
| `trialUsed` | bool | default false |
| `trialLeadsHandled` | int | default 0 |
| `trialLeadsLimit` | int | default 10 |
| `thumbtackBusinessId` | string? | |
| `thumbtackAccountEmail` | string? | |
| `phoneNumber` | string? | Legacy dedicated number |
| `callioAllocationId` | string? | Sigcore allocation ID (`sigcoreAllocationId` in code) |
| `passwordResetToken` | string? | |
| `passwordResetExpires` | datetime? | |

---

### `platforms`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `userId` | string FK→users | |
| `platformName` | string | `thumbtack` \| `yelp` \| `angi` \| `bark` |
| `connected` | bool | default true |
| `externalUserId` | string? | |
| `externalBusinessId` | string? | |
| `credentialsJson` | string | Encrypted |
| `webhookSecret` | string? | Encrypted |
| `webhookId` | string? | |
| `lastSyncAt` | datetime? | |
| `metadataJson` | string? | |
| `createdAt` | datetime | |
| `updatedAt` | datetime | |

---

### `leads`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `userId` | string FK→users | |
| `platform` | string | |
| `businessId` | string? | |
| `externalRequestId` | string UNIQUE | |
| `customerName` | string | |
| `customerPhone` | string? | |
| `customerEmail` | string? | |
| `message` | text | |
| `budget` | decimal? | |
| `postcode` | string? | |
| `city` | string? | |
| `state` | string? | |
| `category` | string? | |
| `status` | string | `new` \| `contacted` \| `quoted` \| `booked` \| `lost` |
| `thumbtackStatus` | string? | e.g. `Hired`, `Not hired` |
| `threadId` | string? FK→conversations | |
| `rawJson` | text | |
| `syncedToCrm` | bool | default false |
| `createdAt` | datetime | |
| `updatedAt` | datetime | |

---

### `conversations`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `userId` | string FK→users | |
| `platform` | string | |
| `externalThreadId` | string UNIQUE | |
| `customerName` | string | |
| `lastMessageAt` | datetime | |
| `unreadCount` | int | default 0 |
| `status` | string | `active` \| `archived` \| `closed` |
| `metadataJson` | text? | |
| `createdAt` | datetime | |
| `updatedAt` | datetime | |

---

### `messages`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `conversationId` | string FK→conversations | |
| `userId` | string FK→users | |
| `platform` | string | |
| `externalMessageId` | string? UNIQUE | |
| `sender` | string | `pro` \| `customer` \| `system` |
| `content` | text | |
| `isRead` | bool | default false |
| `sentAt` | datetime | |
| `deliveredAt` | datetime? | |
| `rawJson` | text? | |
| `notificationLogId` | string? | Links to notification_logs for delivery status |
| `createdAt` | datetime | |

---

### `quotes`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `userId` | string | |
| `platform` | string | |
| `externalQuoteId` | string? | |
| `leadId` | string? | |
| `amount` | decimal | |
| `currency` | string | default `USD` |
| `description` | text? | |
| `status` | string | `pending` \| `accepted` \| `rejected` \| `expired` |
| `validUntil` | datetime? | |
| `rawJson` | text? | |
| `createdAt` | datetime | |
| `updatedAt` | datetime | |

---

### `message_templates`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `userId` | string FK→users | |
| `name` | string | |
| `content` | text | Supports `{variables}` |
| `isDefault` | bool | default false |
| `usageCount` | int | default 0 |
| `lastUsedAt` | datetime? | |
| `createdAt` | datetime | |
| `updatedAt` | datetime | |

---

### `saved_accounts`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `userId` | string FK→users | |
| `platform` | string | e.g. `thumbtack` |
| `businessId` | string | Platform business ID |
| `businessName` | string | Display name |
| `emailHint` | string? | |
| `imageUrl` | string? | |
| `webhookId` | string? | |
| `credentialsJson` | string? | Encrypted |
| `lastUsedAt` | datetime | |
| `createdAt` | datetime | |

---

### `webhook_events`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `platform` | string | |
| `eventType` | string | e.g. `request.created` |
| `payload` | text | |
| `signature` | string? | |
| `verified` | bool | default false |
| `processed` | bool | default false |
| `processingError` | text? | |
| `receivedAt` | datetime | |
| `processedAt` | datetime? | |

---

### `automation_rules`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `savedAccountId` | string FK→saved_accounts | |
| `userId` | string FK→users | |
| `name` | string | |
| `triggerType` | string | `new_lead` \| `customer_reply` |
| `replyTriggerMode` | string? | `first_only` \| `every_reply` |
| `templateId` | string FK→message_templates | |
| `delayMinutes` | int | default 0 |
| `enabled` | bool | default true |
| `triggerCount` | int | default 0 |
| `lastTriggeredAt` | datetime? | |
| `createdAt` | datetime | |
| `updatedAt` | datetime | |

---

### `pending_automated_messages`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `automationRuleId` | string FK→automation_rules | |
| `leadId` | string FK→leads | |
| `negotiationId` | string | External dedup ID |
| `scheduledFor` | datetime | |
| `status` | string | `pending` \| `sent` \| `cancelled` \| `failed` |
| `failureReason` | string? | |
| `sentAt` | datetime? | |
| `createdAt` | datetime | |

---

### `notification_settings`
> ⚠️ Several columns use legacy `callio*` names in the DB — mapped in code to `sigcore*`.

| Column (DB) | Code field | Type | Notes |
|-------------|------------|------|-------|
| `id` | `id` | uuid PK | |
| `savedAccountId` | `savedAccountId` | string? UNIQUE FK→saved_accounts | null = user-level default |
| `userId` | `userId` | string? FK→users | |
| `enabled` | `enabled` | bool | default false |
| `destinationPhone` | `destinationPhone` | string? | Alert destination |
| `senderMode` | `senderMode` | string | `shared` \| `dedicated` \| `openphone` |
| `callioApiKey` | `sigcoreApiKey` | string? | Encrypted Sigcore API key |
| `callioFromPhone` | `sigcoreFromPhone` | string? | BYO phone number selected in UI |
| `callioWorkspaceId` | `sigcoreWorkspaceId` | string? | Sigcore workspace ID |
| `callioWebhookId` | `sigcoreWebhookId` | string? | Delivery status webhook ID |
| `sigcoreProvider` | `sigcoreProvider` | string? | `openphone` \| `twilio` |
| `sigcore_tenant_id` | `sigcoreTenantId` | string? | Sigcore Tenant UUID |
| `sigcore_provisioned_at` | `sigcoreProvisionedAt` | datetime? | When tenant was provisioned |
| `template` | `template` | text | Default alert SMS template |
| `quietHoursStart` | `quietHoursStart` | string? | e.g. `22:00` |
| `quietHoursEnd` | `quietHoursEnd` | string? | e.g. `08:00` |
| `quietHoursTimezone` | `quietHoursTimezone` | string? | default `America/New_York` |
| `requirePhone` | `requirePhone` | bool | default true |
| `customerTextingEnabled` | `customerTextingEnabled` | bool | default false |
| `inboundSmsWebhookId` | `inboundSmsWebhookId` | string? | Inbound SMS webhook ID |
| `smsForwardingNumber` | `smsForwardingNumber` | string? | Forward inbound SMS to (E.164) |
| `callForwardingNumber` | `callForwardingNumber` | string? | Forward inbound calls to (E.164) |
| `createdAt` | `createdAt` | datetime | |
| `updatedAt` | `updatedAt` | datetime | |

---

### `notification_rules`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `notificationSettingsId` | string FK→notification_settings | |
| `name` | string | |
| `triggerType` | string | `new_lead` \| `customer_reply` |
| `replyTriggerMode` | string? | `first_only` \| `every_reply` |
| `fromPhone` | string? | Send FROM this number |
| `toPhone` | string? | Send TO this number |
| `sendToCustomer` | bool | default false — send to lead.customerPhone |
| `template` | text | SMS template (fallback) |
| `templateId` | string? FK→message_templates | |
| `delayMinutes` | int | default 0 |
| `stopOnCustomerReply` | bool | default true |
| `stopOnLeadClosed` | bool | default true |
| `stopOnOptOut` | bool | default true |
| `enabled` | bool | default true |
| `triggerCount` | int | default 0 |
| `lastTriggeredAt` | datetime? | |
| `createdAt` | datetime | |
| `updatedAt` | datetime | |

---

### `pending_notification_messages`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `notificationRuleId` | string FK→notification_rules | |
| `leadId` | string FK→leads | |
| `savedAccountId` | string | For quick lookups |
| `scheduledFor` | datetime | |
| `status` | string | `pending` \| `sent` \| `cancelled` \| `failed` |
| `failureReason` | string? | |
| `sentAt` | datetime? | |
| `createdAt` | datetime | |

---

### `notification_logs`
| Column (DB) | Code field | Type | Notes |
|-------------|------------|------|-------|
| `id` | `id` | uuid PK | |
| `notificationSettingsId` | `notificationSettingsId` | string FK→notification_settings | |
| `notificationRuleId` | `notificationRuleId` | string? FK→notification_rules | |
| `ruleName` | `ruleName` | string? | Cached at send time |
| `leadId` | `leadId` | string? | |
| `toPhone` | `toPhone` | string | |
| `fromPhone` | `fromPhone` | string? | |
| `provider` | `provider` | string? | `twilio` \| `openphone` |
| `callioMessageId` | `sigcoreMessageId` | string? | Sigcore message ID |
| `callioConversationId` | `sigcoreConversationId` | string? | Sigcore conversation ID |
| `status` | `status` | string | `pending` \| `queued` \| `sent` \| `delivered` \| `failed` |
| `error` | `error` | text? | |
| `messageBody` | `messageBody` | text | Rendered content |
| `metadata` | `metadata` | text? | JSON |
| `createdAt` | `createdAt` | datetime | |
| `sentAt` | `sentAt` | datetime? | |
| `deliveredAt` | `deliveredAt` | datetime? | |

---

### `subscription_history`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `userId` | string FK→users | |
| `tier` | SubscriptionTier | |
| `status` | SubscriptionStatus | |
| `eventType` | string | e.g. `subscription.created` |
| `stripeEventId` | string UNIQUE | |
| `metadata` | json? | Full Stripe event |
| `createdAt` | datetime | |

---

### `admin_logs`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `adminId` | string FK→users | |
| `action` | string | e.g. `UPDATE_USER_SUBSCRIPTION` |
| `targetUserId` | string? | |
| `details` | json? | |
| `createdAt` | datetime | |

---

### `phone_pool`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `phoneNumber` | string UNIQUE | E.164 |
| `provider` | string | `twilio` \| `openphone`, default `twilio` |
| `areaCode` | string? | |
| `state` | string? | US state abbreviation |
| `friendlyName` | string? | |
| `sigcoreAllocationId` | string? | |
| `status` | PhonePoolStatus | default `AVAILABLE` |
| `assignedToUserId` | string? FK→users | Legacy |
| `assignedAt` | datetime? | Legacy |
| `provisionedAt` | datetime | |
| `releasedAt` | datetime? | |
| `smsApproved` | bool | A2P 10DLC approved, default true |
| `smsCapable` | bool | default false |
| `voiceCapable` | bool | default false |
| `createdAt` | datetime | |
| `updatedAt` | datetime | |

---

### `phone_pool_assignments`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `phonePoolId` | string FK→phone_pool | |
| `userId` | string FK→users | |
| `assignedAt` | datetime | |

---

### `call_connect_settings`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `savedAccountId` | string UNIQUE FK→saved_accounts | |
| `userId` | string FK→users | |
| `enabled` | bool | default false |
| `mode` | CallConnectMode | default `AGENT_FIRST` |
| `agentStrategy` | string | `owner` \| `round_robin` \| `on_duty` |
| `agentPhoneE164` | string? | Agent's phone to ring |
| `botNumberE164` | string? | Dedicated number calls come FROM |
| `sigcoreWebhookSecret` | string? | HMAC secret |
| `sigcoreWebhookId` | string? | Webhook subscription ID |
| `maxAgentAttempts` | int | default 2 |
| `quietHoursEnabled` | bool | default false |
| `quietHoursTimezone` | string? | |
| `quietHoursStart` | string? | `HH:MM` |
| `quietHoursEnd` | string? | `HH:MM` |
| `agentAcceptDigits` | string? | default `0123456789*#` |
| `agentWhisperMessage` | string? | TTS for agent |
| `leadGreetingMessage` | string? | TTS for lead while waiting |
| `leadVoicemailEnabled` | bool | default false |
| `leadVoicemailMessage` | string? | TTS voicemail text |
| `leadVoicemailRecordingUrl` | string? | Pre-recorded audio URL |
| `createdAt` | datetime | |
| `updatedAt` | datetime | |

---

### `lead_call_connect`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `leadId` | string FK→leads | |
| `businessId` | string? | Sigcore workspace ID |
| `sigcoreSessionId` | string UNIQUE | |
| `status` | CallConnectStatus | default `CREATED` |
| `attempt` | int | default 0 |
| `lastEventAt` | datetime | |
| `failureReason` | string? | |
| `recordingUrl` | string? | |
| `timeline` | json | Append-only event array, default `[]` |
| `createdAt` | datetime | |
| `updatedAt` | datetime | |

---

### `tenant_phone_numbers`
| Column (DB) | Code field | Type | Notes |
|-------------|------------|------|-------|
| `id` | `id` | uuid PK | |
| `userId` | `userId` | string FK→users | |
| `savedAccountId` | `savedAccountId` | string? | |
| `phoneNumber` | `phoneNumber` | string UNIQUE | E.164 |
| `friendlyName` | `friendlyName` | string? | |
| `areaCode` | `areaCode` | string? | |
| `sigcore_allocation_id` | `sigcoreAllocationId` | string? | Sigcore allocation ID |
| `stripe_sub_item_id` | `stripeSubItemId` | string? | Stripe subscription item |
| `status` | `status` | TenantPhoneStatus | default `ACTIVE` |
| `purchased_at` | `purchasedAt` | datetime | |
| `cancelled_at` | `cancelledAt` | datetime? | |
| `grace_period_ends_at` | `gracePeriodEndsAt` | datetime? | |
| `released_at` | `releasedAt` | datetime? | |
| `created_at` | `createdAt` | datetime | |
| `updated_at` | `updatedAt` | datetime | |

---

### `admin_config`
| Column (DB) | Code field | Type | Notes |
|-------------|------------|------|-------|
| `id` | `id` | string PK | singleton: `"global"` |
| `testCustomerName` | `testCustomerName` | string | default `Test Customer` |
| `testCategory` | `testCategory` | string | default `House Cleaning` |
| `testLocation` | `testLocation` | string | default `Tampa, FL` |
| `test_data` | `testData` | json? | Template variable test values |
| `phone_price_monthly` | `phonePriceMonthly` | decimal? | |
| `phone_grace_period_days` | `phoneGracePeriodDays` | int | default 30 |
| `stripe_price_id` | `stripePriceId` | string? | |
| `created_at` | `createdAt` | datetime | |
| `updated_at` | `updatedAt` | datetime | |

---

### `analytics_cache`
| Column (DB) | Code field | Type | Notes |
|-------------|------------|------|-------|
| `id` | `id` | cuid PK | |
| `cache_key` | `cacheKey` | string UNIQUE | `{userId}::{businessId\|\|'__all__'}` |
| `user_id` | `userId` | string | |
| `data` | `data` | json | |
| `calculated_at` | `calculatedAt` | datetime | |
| `updated_at` | `updatedAt` | datetime | |

---

### `thumbtack_settings_snapshots`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `userId` | string FK→users | |
| `savedAccountId` | string? FK→saved_accounts | |
| `provider` | string | default `thumbtack` |
| `snapshotType` | string | default `budget` |
| `scopeCategory` | string? | |
| `scopeLocation` | string? | |
| `weeklyBudget` | decimal | |
| `currency` | string | default `USD` |
| `capturedAt` | datetime | |
| `receivedAt` | datetime | |
| `effectiveFrom` | datetime | |
| `effectiveTo` | datetime? | |
| `source` | string? | |
| `pageUrl` | string? | |
| `pageTitle` | string? | |
| `rawJson` | json? | |

---

### `thumbtack_lead_ids`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `userId` | string FK→users | |
| `savedAccountId` | string? FK→saved_accounts | |
| `thumbtackId` | string | Platform lead ID |
| `batchId` | string? | |
| `capturedAt` | datetime | |
| `collectedAt` | datetime | |
| `source` | string? | |
| `pageUrl` | string? | |
| `pageTitle` | string? | |
| `thumbtackStatus` | string? | |
| `customerName` | string? | |
| `leadDate` | string? | e.g. `Feb 23` |
| `imported` | bool | default false |
| `importedAt` | datetime? | |
| `needsRefetch` | bool | default false |
| `lastActivityAt` | datetime? | |

---

## Key Relationships

```
users
 ├── platforms (1:N)
 ├── leads (1:N)
 ├── conversations (1:N)
 ├── messages (1:N)
 ├── saved_accounts (1:N)
 │    ├── notification_settings (1:1)
 │    │    ├── notification_rules (1:N)
 │    │    └── notification_logs (1:N)
 │    └── call_connect_settings (1:1)
 ├── message_templates (1:N)
 ├── automation_rules (1:N)
 ├── phone_pool (1:N legacy)
 ├── phone_pool_assignments (1:N) → phone_pool
 ├── tenant_phone_numbers (1:N)
 └── subscription_history (1:N)

leads
 ├── conversations (N:1 via threadId)
 ├── pending_automated_messages (1:N)
 ├── pending_notification_messages (1:N)
 └── lead_call_connect (1:N)
```

---

## Phone Number Types (Quick Reference)

| Type | Table | Scope | SMS | Calls |
|------|-------|-------|-----|-------|
| **Pool** | `phone_pool` + `phone_pool_assignments` | Shared (platform key) | Alerts only | ❌ |
| **BYO / OpenPhone** | `notification_settings.callioFromPhone` | Per-tenant (tenant key) | ✅ Alerts + Customer | ❌ |
| **Dedicated** | `tenant_phone_numbers` | Per-tenant (tenant key) | ✅ All | ✅ CC only |
