# Supabase Setup Guide

Complete guide to setting up Supabase for your Thumbtack Bridge project.

## Why Supabase?

✅ **Free tier** with generous limits
✅ **Hosted PostgreSQL** - no local setup needed
✅ **Auto backups** and point-in-time recovery
✅ **Built-in dashboard** for viewing data
✅ **Connection pooling** for better performance
✅ **Global CDN** for fast access worldwide

## Step-by-Step Setup

### 1. Create a Supabase Account

1. Go to https://supabase.com
2. Click **Start your project**
3. Sign up with GitHub, Google, or email

### 2. Create a New Project

1. Click **New Project**
2. Fill in the details:
   - **Name**: `thumbtack-bridge` (or your preferred name)
   - **Database Password**: Generate a strong password and **save it**
   - **Region**: Choose the closest to your users
   - **Pricing Plan**: Free (or Pro if you need more)

3. Click **Create new project**
4. Wait 2-3 minutes for provisioning ☕

### 3. Get Your Database Connection Strings

Once your project is ready:

1. Go to **Settings** (gear icon in sidebar)
2. Click **Database**
3. Scroll to **Connection string**

You'll need **TWO** connection strings:

#### Connection Pooling (for DATABASE_URL)

1. Select **Connection pooling**
2. Mode: **Transaction**
3. Copy the URI (should include port `6543`)
4. Replace `[YOUR-PASSWORD]` with your database password

Example:
```
postgresql://postgres.xxxxxxxxxxxxx:YOUR-PASSWORD@aws-0-us-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true
```

#### Direct Connection (for DIRECT_URL)

1. Select **Connection string**
2. Copy the URI (should include port `5432`)
3. Replace `[YOUR-PASSWORD]` with your database password

Example:
```
postgresql://postgres.xxxxxxxxxxxxx:YOUR-PASSWORD@aws-0-us-west-1.compute.amazonaws.com:5432/postgres
```

### 4. Update Your .env File

Open your `.env` file and paste both connection strings:

```bash
# Supabase Database
DATABASE_URL="postgresql://postgres.xxxxx:YOUR-PASSWORD@aws-0-us-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
DIRECT_URL="postgresql://postgres.xxxxx:YOUR-PASSWORD@aws-0-us-west-1.compute.amazonaws.com:5432/postgres"
```

**Important**: Replace `YOUR-PASSWORD` with your actual database password!

### 5. Run Migrations

Now create your tables:

```bash
# Generate Prisma client
npm run prisma:generate

# Create tables in Supabase
npm run prisma:migrate
```

When prompted for a migration name, use: `init`

### 6. Verify in Supabase Dashboard

1. Go to **Table Editor** in your Supabase dashboard
2. You should see 8 tables:
   - users
   - platforms
   - leads
   - conversations
   - messages
   - quotes
   - webhook_events

🎉 Your database is ready!

## Understanding the Two Connection Strings

### DATABASE_URL (Connection Pooling - Port 6543)

- Uses **PgBouncer** for connection pooling
- Better for serverless/edge deployments
- Handles many concurrent connections efficiently
- Used by default in your application

### DIRECT_URL (Direct Connection - Port 5432)

- Direct connection to PostgreSQL
- Required for migrations and schema operations
- Prisma uses this for `prisma migrate` and `prisma db push`

## Viewing Your Data

Supabase provides several ways to view and manage your data:

### Table Editor (GUI)

1. Go to **Table Editor** in the sidebar
2. Click on any table to view/edit data
3. Add rows manually using the **Insert** button
4. Use filters to search data

### SQL Editor

1. Go to **SQL Editor** in the sidebar
2. Write custom SQL queries
3. Save frequently used queries

Example queries:

```sql
-- View all users
SELECT * FROM users;

-- View all leads
SELECT * FROM leads ORDER BY created_at DESC;

-- Count leads by platform
SELECT platform, COUNT(*) as count
FROM leads
GROUP BY platform;

-- View webhook events
SELECT * FROM webhook_events
WHERE processed = false
ORDER BY received_at DESC;
```

## Supabase Free Tier Limits

Perfect for development and small-scale production:

- ✅ **500 MB database** space
- ✅ **2 GB bandwidth** per month
- ✅ **50 MB file storage**
- ✅ **Unlimited API requests**
- ✅ **50,000 monthly active users**
- ✅ **7 days of log retention**
- ✅ Projects pause after 1 week of inactivity (easily resume)

## Upgrading to Pro

If you need more resources:

- 💎 **$25/month** per project
- 💎 **8 GB database** space
- 💎 **250 GB bandwidth**
- 💎 **100 GB file storage**
- 💎 **No auto-pause**
- 💎 **Daily backups** (7 days retention)

## Backups & Recovery

### Automatic Backups (Pro Plan)

- Daily backups retained for 7 days
- Go to **Settings** → **Database** → **Backups**

### Manual Backups (Free & Pro)

Export your database:

```bash
# Using pg_dump (install PostgreSQL client tools first)
pg_dump "YOUR_DIRECT_URL" > backup.sql

# Or use Supabase CLI
supabase db dump -f backup.sql
```

Restore from backup:

```bash
psql "YOUR_DIRECT_URL" < backup.sql
```

## Performance Tips

### Enable Connection Pooling

Already configured in your `DATABASE_URL` with `?pgbouncer=true`

### Add Database Indexes

The Prisma schema already includes indexes on frequently queried fields:

```prisma
@@index([userId])
@@index([platform])
@@index([status])
@@index([createdAt])
```

### Monitor Performance

1. Go to **Reports** in Supabase dashboard
2. View:
   - Database size
   - Query performance
   - Connection stats
   - API usage

## Security Best Practices

### 1. Row Level Security (RLS)

Supabase has RLS enabled by default. Since we're using Prisma with the service role, we can disable it for our tables:

```sql
-- Disable RLS for Prisma tables (run in SQL Editor)
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
ALTER TABLE platforms DISABLE ROW LEVEL SECURITY;
ALTER TABLE leads DISABLE ROW LEVEL SECURITY;
ALTER TABLE conversations DISABLE ROW LEVEL SECURITY;
ALTER TABLE messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE quotes DISABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events DISABLE ROW LEVEL SECURITY;
```

### 2. Keep Your Password Secure

- ❌ Never commit `.env` to git
- ✅ Use different passwords for dev/staging/production
- ✅ Store production passwords in secure vault (1Password, etc.)

### 3. Use Environment Variables

- In production, set environment variables in your hosting platform
- Don't hardcode connection strings in code

## Troubleshooting

### "Could not connect to database"

1. Check if Supabase project is active (not paused)
2. Verify connection strings are correct
3. Make sure password is correct (no spaces, special chars encoded)
4. Try the direct connection URL to test connectivity

### "Password authentication failed"

- Double-check your database password
- Try resetting the password in **Settings** → **Database**

### "Too many connections"

- You're hitting the connection limit
- Make sure you're using connection pooling (`DATABASE_URL` with port 6543)
- Close unused database connections

### "Migration failed"

- Use `DIRECT_URL` for migrations (not pooled connection)
- Make sure `directUrl` is set in `prisma/schema.prisma`

## Next Steps

Now that your database is set up:

1. ✅ Update your `.env` with connection strings
2. ✅ Run `npm run prisma:migrate`
3. ✅ Start your server with `npm run start:dev`
4. ✅ Test the API endpoints
5. ✅ View your data in Supabase Table Editor

## Useful Resources

- 📖 [Supabase Docs](https://supabase.com/docs)
- 📖 [Prisma + Supabase Guide](https://supabase.com/docs/guides/integrations/prisma)
- 📖 [Connection Pooling](https://supabase.com/docs/guides/database/connecting-to-postgres#connection-pooler)
- 💬 [Supabase Discord](https://discord.supabase.com)

---

**Ready to go?** Head back to [QUICKSTART.md](./QUICKSTART.md) to continue! 🚀
