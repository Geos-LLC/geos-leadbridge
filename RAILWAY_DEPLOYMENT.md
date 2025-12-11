# Railway Deployment Guide

Complete guide to deploying your Thumbtack Bridge API to Railway.

## Why Railway?

✅ **Free Tier**: $5 free credits monthly
✅ **One-Click Deploy**: Automatic builds from GitHub
✅ **PostgreSQL Ready**: Works perfectly with Supabase
✅ **Environment Variables**: Easy configuration
✅ **HTTPS by default**: Automatic SSL certificates
✅ **Custom Domains**: Add your own domain (optional)

---

## Step 1: Prepare Your Repository

### 1.1 Initialize Git (if not already done)

```bash
git init
git add .
git commit -m "Initial commit: Thumbtack Bridge API"
```

### 1.2 Create GitHub Repository

1. Go to https://github.com/new
2. Create a new repository (e.g., `thumbtack-bridge`)
3. **Don't** initialize with README (you already have one)
4. Copy the remote URL

### 1.3 Push to GitHub

```bash
git remote add origin https://github.com/YOUR_USERNAME/thumbtack-bridge.git
git branch -M main
git push -u origin main
```

---

## Step 2: Deploy to Railway

### 2.1 Create Railway Account

1. Go to https://railway.app
2. Click **Login with GitHub**
3. Authorize Railway to access your repositories

### 2.2 Create New Project

1. Click **New Project**
2. Select **Deploy from GitHub repo**
3. Choose your `thumbtack-bridge` repository
4. Click **Deploy Now**

Railway will automatically:
- Detect it's a Node.js project
- Install dependencies (`npm install`)
- Build the project (`npm run build`)
- Start the server (`npm run start:prod`)

### 2.3 Wait for Deployment

The first deployment takes 2-3 minutes. You'll see:
- ✅ Building...
- ✅ Deploying...
- ✅ Success!

---

## Step 3: Configure Environment Variables

### 3.1 Open Settings

1. Click on your deployed service
2. Go to **Variables** tab
3. Click **+ New Variable**

### 3.2 Add All Environment Variables

Add these one by one (get values from your local `.env` file):

#### Database (Supabase)
```
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.xxxxx.supabase.co:5432/postgres
DIRECT_URL=postgresql://postgres.xxxxx:YOUR_PASSWORD@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true
```

#### Server
```
PORT=3000
NODE_ENV=production
```

#### JWT Authentication
```
JWT_SECRET=your-jwt-secret-here
JWT_EXPIRES_IN=7d
```

#### Encryption
```
ENCRYPTION_KEY=your-32-char-encryption-key
```

#### Thumbtack API (you'll get these after approval)
```
THUMBTACK_CLIENT_ID=your-client-id
THUMBTACK_CLIENT_SECRET=your-client-secret
THUMBTACK_REDIRECT_URI=https://YOUR_RAILWAY_DOMAIN/api/v1/thumbtack/auth/callback
THUMBTACK_WEBHOOK_SECRET=your-webhook-secret
```

### 3.3 Get Your Railway Domain

After deployment, Railway provides a public URL like:
```
https://thumbtack-bridge-production.up.railway.app
```

You can find it:
1. Click on your service
2. Go to **Settings** tab
3. Look for **Domains** section
4. Copy the `.up.railway.app` domain

### 3.4 Update THUMBTACK_REDIRECT_URI

Update the variable with your actual Railway domain:
```
THUMBTACK_REDIRECT_URI=https://thumbtack-bridge-production.up.railway.app/api/v1/thumbtack/auth/callback
```

Click **Deploy** to restart with new variables.

---

## Step 4: Verify Deployment

### 4.1 Check Health

Visit your Railway URL in a browser:
```
https://YOUR_RAILWAY_DOMAIN.up.railway.app/api/auth/profile
```

You should see: `{"statusCode":401,"message":"Unauthorized"}`
✅ This is correct! (It means the API is running but needs authentication)

### 4.2 Test API Endpoints

Use the PowerShell script with your Railway URL:

```powershell
# Register a user
$body = @{
    email = "test@example.com"
    password = "Test123!"
    name = "Test User"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "https://YOUR_RAILWAY_DOMAIN.up.railway.app/api/auth/register" `
    -Method Post `
    -ContentType "application/json" `
    -Body $body

$token = $response.token
Write-Host "Token: $token"
```

---

## Step 5: Run Database Migrations

### 5.1 Install Railway CLI (Optional)

```bash
npm install -g @railway/cli
railway login
railway link
```

### 5.2 Run Migrations

**Option A: From Railway Dashboard**

1. Go to your service
2. Click **Deployments** tab
3. Click on the latest deployment
4. Click **View Logs**
5. Check if migrations ran automatically

**Option B: Manually via Local CLI**

```bash
# Set Railway environment
railway run npx prisma migrate deploy
```

**Option C: One-Time Job**

Railway should automatically run migrations on build. If not, you can add a build hook in `package.json`:

```json
"scripts": {
  "build": "nest build && npx prisma migrate deploy"
}
```

---

## Step 6: Update Thumbtack Application

Now that you have a production URL, fill out the Thumbtack API form:

### Technical Info
- **OAuth Experience**: Less than 1 year (or your actual experience)
- **Environments**: ✓ Production, ✓ Development, ✓ Local

### Setup Info
```
Client URI: https://YOUR_RAILWAY_DOMAIN.up.railway.app

Redirect URIs:
  - https://YOUR_RAILWAY_DOMAIN.up.railway.app/api/v1/thumbtack/auth/callback
  - http://localhost:3000/api/v1/thumbtack/auth/callback

Contacts: your-email@example.com

Logo URI: https://YOUR_RAILWAY_DOMAIN.up.railway.app/logo.png (optional)

Policy URI: https://YOUR_RAILWAY_DOMAIN.up.railway.app/privacy (optional)

Terms URI: https://YOUR_RAILWAY_DOMAIN.up.railway.app/terms (optional)
```

---

## Step 7: Configure Webhooks (After Thumbtack Approval)

Once approved, configure webhooks in Thumbtack dashboard:

```
Webhook URL: https://YOUR_RAILWAY_DOMAIN.up.railway.app/api/webhooks/thumbtack
Webhook Secret: (copy from Thumbtack and add to Railway env vars)
```

---

## Monitoring & Logs

### View Logs
1. Go to your Railway project
2. Click on your service
3. Click **Deployments**
4. Click on latest deployment
5. Click **View Logs**

### Metrics
Railway provides:
- CPU usage
- Memory usage
- Network traffic
- Build times

### Alerts
Set up alerts for:
- Deployment failures
- High memory usage
- Crash loops

---

## Custom Domain (Optional)

### Add Your Own Domain

1. Go to **Settings** → **Domains**
2. Click **+ Custom Domain**
3. Enter your domain (e.g., `api.yourdomain.com`)
4. Add the CNAME record to your DNS:
   ```
   CNAME api YOUR_RAILWAY_DOMAIN.up.railway.app
   ```
5. Wait for DNS propagation (5-30 minutes)
6. Update `THUMBTACK_REDIRECT_URI` in Railway variables
7. Update Thumbtack application with new domain

---

## Troubleshooting

### Build Fails

**Error**: `Cannot find module`
- Make sure all dependencies are in `package.json`
- Check `package-lock.json` is committed

**Error**: `Build exceeded memory limit`
- Upgrade Railway plan or optimize build

### Application Crashes

**Error**: `Cannot connect to database`
- Check `DATABASE_URL` is correct in Railway variables
- Verify Supabase project is active
- Check if URL is URL-encoded

**Error**: `Port already in use`
- Railway automatically sets `PORT` variable
- Make sure your app uses `process.env.PORT`

### Environment Variables Not Loading

- Click **Redeploy** after adding/changing variables
- Check variable names match exactly (case-sensitive)
- No quotes needed in Railway UI (add values directly)

---

## Cost Estimate

**Railway Free Tier**:
- $5 free credits per month
- ~500 hours of execution time
- Perfect for development/testing

**Railway Pro Plan** ($5-20/month):
- More execution time
- Better performance
- Custom domains included
- Priority support

---

## Updating Your Deployment

### Push Updates

```bash
git add .
git commit -m "Update: your changes"
git push
```

Railway automatically:
1. Detects the push
2. Builds the new version
3. Runs tests (if configured)
4. Deploys with zero downtime

---

## Next Steps After Deployment

1. ✅ Get your Railway URL
2. ✅ Test all API endpoints on production
3. ✅ Submit Thumbtack API application with Railway URL
4. ✅ Wait for Thumbtack approval
5. ✅ Add Thumbtack credentials to Railway variables
6. ✅ Configure webhooks
7. ✅ Start receiving leads!

---

**Your Production URL will be**:
`https://thumbtack-bridge-production.up.railway.app`

**Use this for your Thumbtack API application!** 🚀
