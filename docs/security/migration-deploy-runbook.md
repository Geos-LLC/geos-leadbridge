# Migration Deploy Runbook

How Prisma migrations reach production, how to apply one manually if you must, and how to roll back. Last updated 2026-04-28 after the auto-migrate work landed (PRs #128, #130, #132).

---

## Default flow — auto-migrate on every deploy

**Production startCommand** (set in the Railway dashboard, not `railway.json`):

```
DATABASE_URL="$DIRECT_URL" npx prisma migrate deploy && node dist/main.js
```

Every Railway deploy:

1. Builds the image (Railpack V3, using the project's Dockerfile).
2. Container starts. The env-prefix `DATABASE_URL="$DIRECT_URL"` only applies to the migrate command via shell scoping; the API process keeps the original `DATABASE_URL` (pgbouncer pool on port 6543).
3. `npx prisma migrate deploy` runs against the direct port 5432 connection. Idempotent — no-ops if there's nothing pending.
4. On migrate success, `&&` runs `node dist/main.js` and the API boots.
5. On migrate failure, `&&` short-circuits, Nest never starts, the deploy fails, Railway preserves the previous container — **no customer impact**.

This is durable: it's been verified live across Phase 2/3/4 deploys.

---

## Why two database URLs

| Var | Port | Used by | Why |
|---|---|---|---|
| `DATABASE_URL` | 6543 | the runtime API process | Supabase pgbouncer (transaction-mode pooling). Short-lived queries flow through fine. |
| `DIRECT_URL` | 5432 | `prisma migrate deploy` only | Prisma's migrate engine opens a long-lived connection; pgbouncer severs it after a few seconds with `P1017: Server has closed the connection`. |

If you ever see `P1017` in deploy logs, the env-prefix on the startCommand was lost. Restore it.

---

## The "prisma in dependencies" requirement

`prisma` lives in `package.json` `dependencies` (not `devDependencies`). This matters because production runs `npm ci --omit=dev` and any `devDependency` is stripped from the runtime image.

If `prisma` weren't in `dependencies`, this would happen on boot:

1. `npx prisma migrate deploy` — npx finds no local prisma binary
2. npx auto-installs the **latest** prisma from npm (currently 7.x)
3. Latest prisma's migrate engine has a different schema-version contract from our 6.19.1 client
4. Migrate engine **silently no-ops** pending migrations and exits 0
5. `&&` doesn't short-circuit, Nest boots normally
6. Migration never applied — but you don't see any error

This was the actual production failure mode for the Phase 3 `add_support_grants` migration on 2026-04-28, fixed in PR #132. **Don't move `prisma` back to `devDependencies`.** The image is ~30MB larger; that's the whole cost.

---

## Why the dashboard, not `railway.json`

`railway.json` is **ignored** by this project's Railway service (`railwayConfigFile: null` in the dashboard). All boot config lives in the dashboard, mutable via the GraphQL API. Editing `railway.json` to change `startCommand` does nothing.

The dashboard `serviceManifest.deploy.startCommand` is the source of truth. To inspect or update it programmatically, see "Recipes" below.

Two related gotchas:

- The `railway.json` `builder: "NIXPACKS"` field is misleading — the real builder is **RAILPACK**, set in the dashboard. RAILPACK auto-detects and uses the project's Dockerfile.
- Railway's RAILPACK V3 runtime is alpine-based. **Don't use `bash` in startCommands** — only `sh` is available. POSIX `&&` works fine in `sh`.

---

## Recipes

### Recipe 1 — apply a migration manually (worst-case fallback)

Used when the auto-migrate path fails for any reason and you need to ship the migration without redeploying. Requires local repo at the same Prisma version as production schema.

```bash
RAILWAY_TOKEN=$(aws secretsmanager get-secret-value --secret-id geos-dashboard-tokens --region us-east-1 \
  --query 'SecretString' --output text | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{d=d.replace(/^\xef\xbb\xbf/,'');console.log(JSON.parse(d).RAILWAY_TOKEN)})")

PROJECT="af5d4f09-6bb6-49c6-ae0c-cf72fda35c88"
SERVICE_ID="d59d2d4c-816a-4639-9687-8e0ec7b487cf"
ENV_ID="69d744fa-6fc4-48b3-83c9-4aac67a6081a"     # production env
# ENV_ID="...staging..."                           # for staging — look up if needed

VARS=$(curl -s "https://backboard.railway.com/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\":\"{ variablesForServiceDeployment(projectId: \\\"$PROJECT\\\", serviceId: \\\"$SERVICE_ID\\\", environmentId: \\\"$ENV_ID\\\") }\"}")

export DATABASE_URL=$(echo "$VARS" | python -c "import json,sys; print(json.load(sys.stdin)['data']['variablesForServiceDeployment']['DIRECT_URL'])")

npx prisma migrate status   # check what's pending
npx prisma migrate deploy   # apply
```

Critical: `npm ci` first to ensure your local `node_modules/prisma` matches the schema version. A locally-running `npx prisma migrate deploy` from a stale tree will hit the same silent-no-op trap that PR #132 fixed for production.

### Recipe 2 — confirm production schema is in sync

Same `DIRECT_URL` lookup as Recipe 1, then:

```bash
DATABASE_URL=$DIRECT_URL npx prisma migrate status
```

Expected output:

```
30 migrations found in prisma/migrations

Database schema is up to date!
```

If you see `Following migrations have not yet been applied`, run Recipe 1 to apply them.

### Recipe 3 — read the dashboard startCommand

```bash
curl -s "https://backboard.railway.com/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\":\"query { deployments(first: 1, input: { serviceId: \\\"$SERVICE_ID\\\", environmentId: \\\"$ENV_ID\\\" }) { edges { node { id status meta } } } }\"}" \
  | python -c "
import json, sys
d = json.load(sys.stdin)
n = d['data']['deployments']['edges'][0]['node']
m = n['meta']['serviceManifest']['deploy']
print('builder:', n['meta']['serviceManifest']['build']['builder'])
print('startCommand:', m['startCommand'])
"
```

### Recipe 4 — change the dashboard startCommand

Use sparingly. Keep production and staging in sync.

```bash
NEW_START_CMD='DATABASE_URL="$DIRECT_URL" npx prisma migrate deploy && node dist/main.js'

curl -s "https://backboard.railway.com/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"mutation Update($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }","variables":{"serviceId":"'$SERVICE_ID'","environmentId":"'$ENV_ID'","input":{"startCommand":"'"$NEW_START_CMD"'"}}}'
```

Notes:
- `startCommand: null` in the API is treated as **no change**. To clear an override, send `""` (empty string).
- A `serviceInstanceUpdate` does not redeploy on its own. You need a redeploy (a push, or `serviceInstanceDeployV2`) for the new command to take effect.

---

## Rollback

If a deploy regresses production, the safest rollback is to redeploy the last known-good deploy by id (Railway preserves the image). Look it up:

```bash
curl -s "https://backboard.railway.com/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\":\"query { deployments(first: 5, input: { serviceId: \\\"$SERVICE_ID\\\", environmentId: \\\"$ENV_ID\\\" }) { edges { node { id status createdAt meta } } } }\"}"
```

Pick the most recent `SUCCESS` deploy that predates the regression, then trigger `deploymentRedeploy(id: <thatDeployId>)`.

If the bad deploy applied a migration, **the migration is still in the schema** after the redeploy. Schema rollbacks are explicit — write a new "down" migration and ship it forward; do not try to `prisma migrate resolve --rolled-back` on production.

---

## Don't

- **Don't run `prisma migrate dev` against production.** It uses shadow databases and can drop tables. Use `prisma migrate deploy` only.
- **Don't redirect migration commands to the pgbouncer URL (port 6543).** You'll see `P1017` after a few seconds.
- **Don't use `--no-verify` or `--no-gpg-sign` to bypass hooks during a migration push.** If a hook fails, fix the cause.
- **Don't move `prisma` back to `devDependencies`.** See "The 'prisma in dependencies' requirement" above.
- **Don't put `bash` in any startCommand.** Alpine runtime has only `sh`.
- **Don't trust `railway.json`** for boot config — it is ignored. Edit the dashboard.

---

## Failure runbook

### Deploy is BUILDING for >10 min
Build genuinely takes ~90s normally. Check the Railway dashboard build logs. If npm install is slow or hanging, it's usually a registry issue or a new dependency that pulled a large transitive tree.

### Deploy goes BUILDING → FAILED
Check `serviceManifest` for the deploy. If startCommand contains `bash`, that's the issue (alpine has no bash). Restore the canonical command from "Default flow" above.

### Deploy goes BUILDING → SUCCESS → API crashloops
Pull container stdout via `deploymentLogs` API. Look for `ExceptionHandler|FATAL|Cannot find module|Cannot read`. Common causes:
- a new env var the code requires but isn't set in Railway
- a new package added but not committed to lockfile
- a migration that altered a column the code now depends on, but the migration didn't run (silent no-op — see "The 'prisma in dependencies' requirement")

### `prisma migrate status` shows pending migrations after a deploy
Auto-migrate didn't apply them. Almost always means the prisma binary in the runtime image isn't the right version. Run Recipe 1 to apply manually, then investigate why the runtime version drifted.

### Loki shows zero migration output
Expected. Railway's `deploymentLogs` API filters to NestJS-prefixed lines. Migrate output goes to container stdout but isn't captured. To verify migrations actually ran, use `prisma migrate status` (Recipe 2) — querying `_prisma_migrations` directly is the source of truth.

---

## See also
- [current-security-posture.md](current-security-posture.md) — security primitives in place today
- [support-access-runbook.md](support-access-runbook.md) — admin access procedures
- [src/main.ts](../../src/main.ts) — global pipes/CORS/prefix wiring
- [prisma/schema.prisma](../../prisma/schema.prisma) — current schema
