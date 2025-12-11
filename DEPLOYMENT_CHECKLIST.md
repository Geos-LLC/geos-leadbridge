# Deployment Checklist

Use this checklist to deploy your Thumbtack Bridge API to Railway.

## Pre-Deployment Checklist

- [ ] **Git Repository**
  - [ ] All changes committed
  - [ ] Pushed to GitHub
  - [ ] `.env` file is NOT committed (should be in `.gitignore`)

- [ ] **Database**
  - [ ] Supabase project is active
  - [ ] All migrations have been run locally
  - [ ] Database connection strings are ready

- [ ] **Environment Variables**
  - [ ] `DATABASE_URL` - Supabase direct connection
  - [ ] `DIRECT_URL` - Supabase pooled connection
  - [ ] `JWT_SECRET` - Random 32+ character string
  - [ ] `ENCRYPTION_KEY` - Exactly 32 characters
  - [ ] `PORT` - Set to 3000
  - [ ] `NODE_ENV` - Set to production

## Deployment Steps

### Step 1: GitHub Setup

- [ ] Create GitHub repository at https://github.com/new
- [ ] Name: `thumbtack-bridge` (or your preferred name)
- [ ] Make it **Private** (recommended) or Public
- [ ] Don't initialize with README

```bash
# Add all files
git add .

# Commit
git commit -m "Prepare for Railway deployment"

# Add remote (replace YOUR_USERNAME)
git remote add origin https://github.com/YOUR_USERNAME/thumbtack-bridge.git

# Push to GitHub
git push -u origin main
```

### Step 2: Railway Deployment

- [ ] Go to https://railway.app
- [ ] Click **Login with GitHub**
- [ ] Authorize Railway
- [ ] Click **New Project**
- [ ] Select **Deploy from GitHub repo**
- [ ] Choose `thumbtack-bridge` repository
- [ ] Click **Deploy Now**
- [ ] Wait 2-3 minutes for first deployment

### Step 3: Configure Environment Variables

Go to your Railway project → **Variables** tab:

- [ ] Add `DATABASE_URL` (from Supabase - port 5432)
- [ ] Add `DIRECT_URL` (from Supabase - port 6543 with pgbouncer)
- [ ] Add `PORT` = `3000`
- [ ] Add `NODE_ENV` = `production`
- [ ] Add `JWT_SECRET` (same as local)
- [ ] Add `JWT_EXPIRES_IN` = `7d`
- [ ] Add `ENCRYPTION_KEY` (same as local)

**Note**: Leave Thumbtack credentials empty for now (you'll add them after approval)

### Step 4: Get Your Railway Domain

- [ ] Go to **Settings** → **Domains**
- [ ] Copy your Railway domain (e.g., `thumbtack-bridge-production.up.railway.app`)
- [ ] Save this URL - you'll need it for Thumbtack application

### Step 5: Verify Deployment

Test your deployed API:

```powershell
# Test health check
Invoke-RestMethod -Uri "https://YOUR_RAILWAY_DOMAIN.up.railway.app/api/auth/profile"

# Should return: {"statusCode":401,"message":"Unauthorized"}
# ✅ This is correct! API is running.
```

### Step 6: Run Migrations on Railway

Option 1: Automatic (recommended)
- [ ] Migrations should run automatically on build
- [ ] Check deployment logs to verify

Option 2: Manual via Railway CLI
```bash
railway login
railway link
railway run npx prisma migrate deploy
```

### Step 7: Test Production API

```powershell
# Register a test user
$body = @{
    email = "test@example.com"
    password = "Test123!"
    name = "Test User"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "https://YOUR_RAILWAY_DOMAIN.up.railway.app/api/auth/register" `
    -Method Post `
    -ContentType "application/json" `
    -Body $body

# Save token
$token = $response.token

# Test profile
$headers = @{ "Authorization" = "Bearer $token" }
Invoke-RestMethod -Uri "https://YOUR_RAILWAY_DOMAIN.up.railway.app/api/auth/profile" `
    -Method Get `
    -Headers $headers
```

- [ ] User registration works ✅
- [ ] User login works ✅
- [ ] Profile retrieval works ✅

## Post-Deployment

### Thumbtack API Application

Now fill out the Thumbtack API form with your Railway domain:

**Client URI**:
```
https://YOUR_RAILWAY_DOMAIN.up.railway.app
```

**Redirect URIs**:
```
https://YOUR_RAILWAY_DOMAIN.up.railway.app/api/v1/thumbtack/auth/callback
http://localhost:3000/api/v1/thumbtack/auth/callback
```

**Contacts**:
```
your-email@example.com
```

### After Thumbtack Approval

- [ ] Receive `THUMBTACK_CLIENT_ID`
- [ ] Receive `THUMBTACK_CLIENT_SECRET`
- [ ] Receive `THUMBTACK_WEBHOOK_SECRET`

Add these to Railway variables:

- [ ] Add `THUMBTACK_CLIENT_ID`
- [ ] Add `THUMBTACK_CLIENT_SECRET`
- [ ] Add `THUMBTACK_REDIRECT_URI` = `https://YOUR_RAILWAY_DOMAIN.up.railway.app/api/v1/thumbtack/auth/callback`
- [ ] Add `THUMBTACK_WEBHOOK_SECRET`

- [ ] Click **Deploy** to restart with new variables

### Configure Webhooks

In Thumbtack Developer Dashboard:

- [ ] Webhook URL: `https://YOUR_RAILWAY_DOMAIN.up.railway.app/api/webhooks/thumbtack`
- [ ] Webhook Secret: (already added to Railway)
- [ ] Events: Select all relevant events

### Final Testing

- [ ] OAuth flow works
- [ ] Can fetch leads
- [ ] Can send messages
- [ ] Can send quotes
- [ ] Webhooks are received

## Monitoring

### Railway Dashboard

Monitor your application:
- [ ] Check deployment logs regularly
- [ ] Monitor memory usage
- [ ] Monitor CPU usage
- [ ] Set up crash alerts

### Supabase Dashboard

Monitor your database:
- [ ] Check query performance
- [ ] Monitor connection count
- [ ] Review slow queries
- [ ] Check database size

## Troubleshooting

### Build Fails

- Check Railway build logs
- Verify `package.json` has correct scripts
- Ensure all dependencies are listed

### Application Crashes

- Check Railway deployment logs
- Verify environment variables are set correctly
- Test database connection
- Check for missing secrets

### Database Connection Issues

- Verify `DATABASE_URL` is correct
- Check Supabase project is active
- Ensure password is URL-encoded
- Test connection from Railway CLI

### Webhook Issues

- Verify webhook URL is publicly accessible
- Check webhook secret matches
- Review webhook event logs in database
- Test webhook signature verification

---

## Quick Reference

**Your Railway Domain**:
```
https://YOUR_RAILWAY_DOMAIN.up.railway.app
```

**API Endpoints**:
- `POST /api/auth/register` - Register user
- `POST /api/auth/login` - Login
- `GET /api/auth/profile` - Get profile
- `GET /api/v1/thumbtack/auth/url` - Get OAuth URL
- `GET /api/v1/leads` - Get all leads
- `POST /api/webhooks/thumbtack` - Receive webhooks

**Environment Variables**:
- Production: Railway Variables tab
- Local: `.env` file

**Logs**:
- Railway: Deployments → View Logs
- Database: Supabase → Logs

---

**Status**:
- [ ] Not Started
- [ ] In Progress
- [ ] Deployed to Railway ✅
- [ ] Thumbtack Application Submitted ✅
- [ ] Thumbtack Approved & Live ✅

Good luck with your deployment! 🚀
