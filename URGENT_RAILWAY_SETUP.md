# 🚨 URGENT: Add Environment Variables to Railway NOW

Railway is rebuilding but will fail again unless you add environment variables first!

## Go to Railway Dashboard NOW

1. **Open Railway**: https://railway.app/project/YOUR_PROJECT_ID
2. **Click on your service** (thumbtack-bridge)
3. **Go to Variables tab**
4. **Click "+ New Variable"**

## Add These Variables (Copy from your local .env)

### REQUIRED - Add these immediately:

```bash
DATABASE_URL=postgresql://postgres:t.9NBT8K4Vd4f%3F%2B@db.eeeipuztpbubslsxcpew.supabase.co:5432/postgres

DIRECT_URL=postgresql://postgres.eeeipuztpbubslsxcpew:t.9NBT8K4Vd4f%3F%2B@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true

PORT=3000

NODE_ENV=production

JWT_SECRET=ab8970cda0673938447af748aac9a762804b8a73a6262be2f13b56a549a8beb1

JWT_EXPIRES_IN=7d

ENCRYPTION_KEY=ab239ea38eb6e064cbf0972058435c4f
```

### Optional (can add later):

```bash
THUMBTACK_CLIENT_ID=your-client-id
THUMBTACK_CLIENT_SECRET=your-client-secret
THUMBTACK_REDIRECT_URI=https://YOUR_RAILWAY_DOMAIN/api/v1/thumbtack/auth/callback
THUMBTACK_WEBHOOK_SECRET=your-webhook-secret
```

## How to Add Variables in Railway

For each variable:

1. Click **"+ New Variable"** or **"+ Add Variable"**
2. **Variable name**: `DATABASE_URL` (for example)
3. **Value**: `postgresql://postgres:t.9NBT8K4Vd4f%3F%2B@...` (paste the full value)
4. Click **Add** or press Enter
5. Repeat for all variables above

## Important Notes

⚠️ **DO NOT** add quotes around the values in Railway
⚠️ **COPY** the exact values from above (they're already URL-encoded)
⚠️ **ADD** all required variables before the build finishes

## After Adding Variables

Railway will automatically:
1. Detect the new environment variables
2. Trigger a new deployment
3. Run `npm ci` ✅ (will succeed now)
4. Run `npm run build` → `prisma generate && prisma migrate deploy && tsc` ✅
5. Start your app with `npm run start:prod` ✅

## Check Build Status

Watch the deployment:
1. Go to **Deployments** tab in Railway
2. Click on the latest deployment
3. Click **View Logs**
4. Watch for success! ✅

---

**Do this NOW** before the current build finishes! ⏰
