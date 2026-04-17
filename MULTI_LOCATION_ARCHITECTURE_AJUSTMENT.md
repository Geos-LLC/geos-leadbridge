--

# TASK — Update Service Flow Architecture for Multi-Location Communication Mapping

## Goal

Refactor Service Flow’s communication-layer architecture so it supports providers where:

* some providers/accounts map **1 account = 1 location**

  * example: Thumbtack via LeadBridge
* other providers/accounts map **1 account = many locations**

  * example: Yelp via LeadBridge

Service Flow must **not** assume `provider_account = business/location`.

Instead, Service Flow must treat **Location** as the real operational unit for communication routing, filtering, lead mapping, and customer mapping.

---

# Problem

Current Phase A architecture supports:

* `communication_provider_accounts`
* `communication_conversations`
* `communication_participant_identities`

But the model still leans toward using **provider account** as the practical UI and routing unit.

That is not sufficient because:

* Thumbtack may have separate accounts per location
* Yelp may have one account containing multiple locations

So the same system must support:

* **account → one location**
* **account → many locations**

without breaking communication filtering or CRM mapping.

---

# Required Architectural Change

## New rule

**Location is the business unit.**
**Provider account is only an integration container.**

Correct relationship:

```text
Workspace
  └── Location
        ├── Provider account mapping(s)
        └── Conversations / Leads / Customers
```

And for providers:

```text
Provider Account
  └── one or more external provider locations
        └── conversations
```

Service Flow must support this normalized model even if LeadBridge/provider data is inconsistent.

---

# Implementation Scope

This task is an **architecture + schema + backend contract update task**.

Do **not** fully implement Leads conversion logic here.
This task is about making the communication layer **location-aware** so later lead/customer mapping works correctly.

---

# Required Changes

## 1) Introduce a location-aware mapping layer in Service Flow

Add a mapping structure so conversations can resolve to an SF location independently of raw provider account.

### New concept to introduce

Suggested table:

* `communication_provider_account_locations`

Alternative acceptable names:

* `communication_account_locations`
* `communication_location_mappings`

### Purpose

Maps an external provider account and optional external provider location to a Service Flow location/business unit.

### Suggested fields

* `id`
* `workspace_id`
* `provider_account_id` FK → `communication_provider_accounts.id`
* `sf_location_id` or `business_location_id`
* `provider`
* `channel`
* `external_location_id` nullable
* `external_business_id` nullable
* `external_location_name` nullable
* `mapping_type` (`account_level`, `location_level`, `manual`)
* `is_active`
* `metadata` jsonb
* `created_at`
* `updated_at`

### Mapping behavior

#### Thumbtack case

* one account usually maps directly to one SF location
* use `mapping_type = account_level`

#### Yelp case

* one account may map to multiple SF locations
* use `external_location_id` or similar provider location field
* use `mapping_type = location_level`

---

## 2) Extend conversations to store resolved SF location

`communication_conversations` should not rely only on `provider_account_id`.

Add a resolved location reference:

### New column

* `sf_location_id` or the existing location/business-unit FK used by Service Flow

If SF already has a locations table/entity, use that.
If not, use the closest existing business-location abstraction and document it.

### Purpose

Every conversation should eventually resolve to:

* provider account
* external location if applicable
* internal SF location

This makes UI filtering, dispatching, lead creation, and customer mapping much easier later.

---

## 3) Extend conversations to store raw external location context

Add provider-location fields to `communication_conversations`:

### Suggested new columns

* `external_location_id`
* `external_business_id`
* `external_location_name`

These fields are nullable because not all providers expose them.

### Rule

Store raw provider location context on the conversation even if SF location resolution is not yet available.

This allows:

* future remapping
* debugging
* manual correction
* better filtering later

---

## 4) Add location resolution service in backend

Create shared logic in the communication layer:

### New service

Suggested names:

* `resolveConversationLocation(...)`
* `resolveProviderLocationMapping(...)`

### Purpose

Given:

* provider
* channel
* provider_account_id
* external_location_id
* external_business_id
* external_location_name

resolve the correct SF location.

### Resolution rules

1. If there is an exact mapping on:

   * provider account + external location ID
     use that.
2. Else if provider account is mapped at account level to one SF location
   use that.
3. Else leave unresolved (`sf_location_id = null`)
4. Never guess silently from account name unless explicitly designed as fallback
5. Allow unresolved conversations to still be stored

This is important: communication ingestion must not fail just because location mapping is unknown.

---

## 5) Update webhook and sync ingestion flow

When SF ingests conversations from LeadBridge, it must now store both:

* provider account context
* location context

### Update webhook ingest flow

Current flow:

* verify signature
* resolve provider account
* upsert identity
* upsert conversation
* upsert message

### New flow

* verify signature
* resolve provider account
* extract provider location fields if present
* resolve SF location via mapping table/service
* upsert identity
* upsert conversation with:

  * provider_account_id
  * external_location_id
  * external_business_id
  * external_location_name
  * sf_location_id
* upsert message

### Same for sync flow

The sync/backfill path must use the same location-resolution service as webhook ingest.

Do not create separate mapping logic for sync vs webhook.

---

## 6) Change UI thinking from Account Filter → Location Filter

The communication UI should not be designed around provider accounts as the main business selector.

### Current likely thinking

* Thumbtack tab
* Yelp tab
* account filter dropdown

### New required direction

Use **Location** as the main operational filter.

### MVP UI behavior

Top-level tabs remain:

* All
* OpenPhone
* Thumbtack
* Yelp

Secondary filter should be:

* `Location: All Locations`

Optional additional filter:

* `Source Account: All Accounts`

### Conversation row badges

Each conversation should show:

* channel badge
* location badge if resolved
* account badge only as secondary metadata

Examples:

* `Thumbtack · Jacksonville`
* `Yelp · Tampa`
* `Yelp · Unassigned Location`

The key is: users manage operations by location, not by provider account.

---

## 7) Support unresolved location state explicitly

Some conversations may arrive without enough provider-location data.

That should be a valid state.

### Add explicit unresolved state

A conversation may have:

* provider account resolved
* SF location unresolved

### Required UI/backend behavior

* still display the conversation
* badge it as:

  * `Unassigned Location`
  * or `Location Unknown`
* allow future remapping
* do not block messaging

This is especially important for Yelp if provider location metadata is incomplete.

---

## 8) Keep participant identity separate from location

Do not mix:

* participant identity
* provider account
* location
* lead/customer

These are different layers.

Correct model:

```text
conversation
  → participant_identity
  → provider_account
  → external_location_context
  → sf_location
```

Later:

* participant_identity links to lead/customer
* lead/customer may also belong to a location

But do not collapse these concerns now.

---

## 9) Prepare for future lead/customer mapping

This task should make Phase B/C easier.

### Required design principle

When creating or linking leads/customers later:

* the lead/customer should inherit or be associated with the resolved SF location
* if the location is unresolved, the lead can still be created but flagged accordingly

No lead/customer conversion logic is required in this task, but the data model must support it.

---

## 10) DB / migration deliverables

Create a new migration after Migration 006.

### Expected migration contents

At minimum:

1. new location-mapping table
2. new location-related columns on `communication_conversations`
3. necessary indexes
4. `updated_at` trigger if new table uses `updated_at`

### Suggested indexes

On mapping table:

* `(workspace_id, provider_account_id, external_location_id)`
* `(workspace_id, sf_location_id)`
* active mappings index

On conversations:

* `(workspace_id, sf_location_id, channel, last_event_at desc)`
* `(provider_account_id, external_location_id)`

Use nullable-safe and idempotent migration patterns.

---

## 11) Backend deliverables

Update SF backend communication layer to support:

* location-aware provider account mapping
* location resolution service
* webhook ingest storing resolved and raw location fields
* sync ingest storing resolved and raw location fields
* API support for filtering conversations by location

### Suggested endpoints to extend

* `GET /api/communications/conversations`

  * add `locationId` filter
* `GET /api/integrations/leadbridge/accounts`

  * include mapped SF location info where available
* sync and webhook handlers

  * use shared location resolution

---

## 12) Frontend deliverables

Update communications UI so it is location-aware.

### Required changes

* add location filter dropdown
* display location badge on conversation cards
* display unresolved-location badge when needed
* keep account badge secondary, not primary

Do not build nested sub-tabs by business/account.

---

## 13) Important rules

### Must do

* use location as operational unit
* support account→one-location and account→many-locations
* preserve unresolved state
* keep sync and webhook logic shared
* keep provider account and location as separate concepts

### Must not do

* do not assume provider account = location
* do not use account as the only UI/business filter
* do not block message ingestion when location mapping is unknown
* do not collapse identity mapping and location mapping into one mechanism

---

## Deliverables

1. architecture update in SF communication layer
2. new migration for location-aware mapping
3. backend location resolution service
4. conversation model updated with raw + resolved location fields
5. API filters for location-aware conversation listing
6. frontend update to use location badge/filter model
7. short implementation note describing:

   * Thumbtack account-level mapping
   * Yelp multi-location mapping
   * unresolved-location fallback behavior

---

## Acceptance Criteria

This task is complete only when:

* SF no longer assumes `provider_account = location`
* conversations can store provider account and provider location separately
* conversations can resolve to an internal SF location
* Thumbtack one-account-per-location works
* Yelp one-account-many-locations works
* unresolved provider-location conversations are still supported
* communications UI can filter by location
* account badges remain secondary metadata

-