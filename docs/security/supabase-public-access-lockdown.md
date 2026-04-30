# Supabase `public` schema lockdown

Date applied: **2026-04-30**.
Scope: production Supabase project `eeeipuztpbubslsxcpew`.
Operator: pooler user `postgres.eeeipuztpbubslsxcpew` (maps to `postgres` role).

## Summary

The Supabase project's `public` schema had been initialized with `GRANT ALL ON ALL TABLES … TO anon, authenticated`. Combined with the `public` schema being exposed by the Data API by default, this meant any holder of the project anon key could read, insert, update, delete, and TRUNCATE every application table. The frontend has never carried that key, so no exploitation occurred — but the latent risk was unacceptable.

This change revokes those grants and the `postgres`-owned default privileges that would re-establish them on future tables. RLS is **not** enabled and no row-level policies are written; that is deliberate (see "What's NOT in this change" below).

## Audit performed before the change

The pre-flight audit lives in [docs/security/current-security-posture.md](current-security-posture.md). Specifically for this lockdown, the following was confirmed:

- Frontend ([frontend/](../../frontend/)) does not import `@supabase/*`, has no `VITE_SUPABASE_URL`, no anon key, no service-role key. It talks only to the NestJS API.
- Backend ([prisma/schema.prisma](../../prisma/schema.prisma)) connects via Prisma over Postgres (`DATABASE_URL` pgbouncer, `DIRECT_URL` session pooler). No PostgREST, no Supabase JS client, no Realtime subscriptions.
- `pg_publication_tables WHERE pubname='supabase_realtime'` returned 0 rows — Realtime publication empty.
- `pg_roles` showed `postgres.rolbypassrls = true`, `service_role.rolbypassrls = true`. Prisma's connection role bypasses RLS, so any future RLS toggle cannot lock the app out.

## What was revoked

Single transaction, run as the pooler `postgres` role:

```sql
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
```

The `ALTER DEFAULT PRIVILEGES` statements default to `FOR ROLE current_user`, which here is `postgres` — the same role Prisma migrations run as. Future tables created by Prisma therefore do not inherit anon/authenticated grants.

## Before / after numbers

| Check | Before | After |
|---|---:|---:|
| `anon` table-level grants on `public` | 301 | **0** |
| `authenticated` table-level grants on `public` | 301 | **0** |
| Total grants flagged by `information_schema.role_table_grants` | 602 | **0** |
| `postgres`-owned default-ACL on `public` (anon/auth on tables/sequences/functions) | granted (`arwdDxtm` / `rwU` / `X`) | **cleared** |
| `service_role` grants on `public` | preserved | preserved |
| `postgres.rolbypassrls` | true | true |

The 602 grants spanned all 43 objects in `public` (42 application tables defined by Prisma's `@@map` plus `_prisma_migrations`).

## Service role and Prisma path are intact

- `service_role` was deliberately not revoked. Supabase's internal automations and any future server-side use of the Supabase service-role key continue to work.
- The pooler `postgres` role still owns and reads every public-schema object (`pg_class.relowner` shows `postgres` for all 43 tables and 187 indexes).
- A post-change SELECT-count smoke test against the `DATABASE_URL` pooler URL succeeded for `users`, `leads`, `messages`, `saved_accounts`, `notification_logs`, `quotes`, `pending_notification_messages`, `conversation_sync_connections`, `_prisma_migrations` — the same channel Prisma uses at runtime.

## Verification queries

Run these from the pooler `postgres` role (Supabase Dashboard → SQL Editor works too) to confirm the locked-down state. Each should return **0 rows / 0 count**:

```sql
-- 1. Any anon/authenticated table grants?
SELECT grantee, table_name, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public'
   AND grantee IN ('anon','authenticated');

-- 2. Any anon/authenticated sequence/function grants?
SELECT 'sequence' AS kind, grantee, count(*)::int AS n
  FROM information_schema.role_usage_grants
 WHERE object_schema='public' AND grantee IN ('anon','authenticated')
 GROUP BY 1, 2
UNION ALL
SELECT 'function', grantee, count(*)::int
  FROM information_schema.role_routine_grants
 WHERE routine_schema='public' AND grantee IN ('anon','authenticated')
 GROUP BY 1, 2;

-- 3. postgres-owned default-ACL is clean (no anon/auth substrings)
SELECT defaclrole::regrole AS owner_role,
       defaclnamespace::regnamespace AS schema,
       defaclobjtype AS obj_type,
       defaclacl::text AS acl
  FROM pg_default_acl
 WHERE defaclnamespace = 'public'::regnamespace
   AND defaclrole = 'postgres'::regrole;
-- Expected acl strings: only 'postgres=…/postgres' and 'service_role=…/postgres' entries.
```

## Tracked residue — `supabase_admin`-owned default ACL

`pg_default_acl` still holds three entries owned by `supabase_admin` that grant `anon` and `authenticated` `arwdDxtm` / `rwU` / `X` on tables / sequences / functions. These cannot be cleared from this project — both the pooler `postgres` connection and the Supabase Dashboard SQL Editor return:

```
ERROR: 42501: permission denied to change default privileges
```

`postgres` is not a member of `supabase_admin` and Supabase does not expose a self-serve path to grant that membership.

**Why this is acceptable today:**

1. The default ACL only fires when `supabase_admin` creates a new object in `public`.
2. `pg_class` and `pg_proc` show **zero objects in `public` currently owned by `supabase_admin`**. All 43 tables and all functions are owned by `postgres`.
3. Supabase's own automations create objects in dedicated schemas (`auth`, `storage`, `realtime`, `vault`, `extensions`, `pgsodium`, etc.) — not `public`.
4. Prisma migrations run as `postgres`; new LB tables inherit only the `postgres`-owned default-ACL, which is clean.

**When this would matter:**

If a Supabase support engineer or a managed extension installs into `public` and the install runs as `supabase_admin`, the new object would inherit anon/authenticated grants. To close this fully, file a Supabase support request asking them to clear the `supabase_admin`-owned default privileges on `public` (the SQL is below). Until that's done, monitor object ownership in `public`:

```sql
SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relkind
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND pg_get_userbyid(c.relowner) <> 'postgres';
-- Expected: 0 rows.
```

SQL for the Supabase support ticket (cannot be run by us):

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
```

## What's NOT in this change

- **RLS is still disabled on every public-schema table.** Enabling RLS is tracked as Phase 5 in [current-security-posture.md](current-security-posture.md). It is held until the application-level tenancy work (`TenancyService`, `findFirst({ id, userId })`) is fully stable, and it is no longer urgent now that anon/authenticated cannot reach the tables at all.
- **No row-level policies were written.** Policies only become necessary if the frontend ever adopts a Supabase JS client with the anon key — which it does not.
- **No Prisma schema changes.** Lockdown is purely a Postgres-level grant change.
- **No schema relocation.** `public` continues to hold all application tables.

## Threat model after the change

| Threat | Status |
|---|---|
| Attacker discovers project ref + anon key, reads `users`, `leads`, `messages`, etc. via PostgREST | **Closed** — anon has zero grants on public. |
| Attacker uses anon/authenticated key to TRUNCATE/DELETE tables | **Closed** — zero grants. |
| Insider with anon key subscribes to Realtime on app tables | **Closed** by both grant revocation and empty `supabase_realtime` publication. |
| Service-role key leak | Unchanged — service_role was preserved. Treat the service-role key as a production credential; rotate via Supabase Dashboard if leaked. |
| Bug in app code with `findUnique({ where: { id } })` missing tenant scope | Unchanged — application-level tenancy is the control. RLS is the planned defense-in-depth layer (Phase 5). |
| Future supabase_admin-owned object in `public` inherits anon/auth grants | **Tracked residue.** Currently dormant (zero supabase_admin-owned objects in public). Monitor with the query above. |

## Change record

- 602 explicit grants revoked, 0 remaining.
- 3 `postgres`-owned default-ACL rows in `pg_default_acl` cleaned of anon/authenticated entries.
- 3 `supabase_admin`-owned default-ACL rows remain (dormant, see above).
- App path verified by SELECT-count smoke test.
- No Prisma, NestJS, or frontend code touched.
