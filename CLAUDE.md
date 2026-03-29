## Permissions

For this project you are authorized to:
- Push to `staging` branch without confirmation
- Update ECS task definitions and force-new-deployments
- Update AWS Secrets Manager values for `leadbridge-prod-secrets`
- Commit and push code changes on behalf of the user
- Deploy Railway services (via git push)
- Read, edit, and write any files in this project without confirmation
- Run `npx tsc --noEmit`, `cd frontend && npx tsc -b`, and other build/lint checks without confirmation
- Run `git status`, `git diff`, `git log`, `git add`, `git commit` without confirmation
- Run `prisma migrate deploy`, `prisma generate`, and other Prisma commands without confirmation
- Execute bash commands needed for development (npm, npx, git, curl, aws cli) without confirmation
- Query Grafana/Loki logs without confirmation

### Log Querying — Crash Detection
When checking Railway logs for crashes, ALWAYS search for ALL of these patterns:
- `ExceptionHandler` — NestJS uncaught exceptions (may be empty `{}` with no message/stack)
- `error`, `Error`, `FATAL`, `Cannot`, `Nest`
- Unfiltered last 50 lines as a fallback

Do NOT push to `main` without explicit confirmation.
