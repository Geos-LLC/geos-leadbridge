# Next Steps - Deploy to Railway & Get Thumbtack Access

## You Are Here ✅

Your Thumbtack Bridge API is **fully built and ready for deployment**!

- ✅ Backend service complete
- ✅ Database schema created in Supabase
- ✅ All API endpoints implemented and tested locally
- ✅ Security features implemented (JWT, encryption, webhook verification)
- ✅ Code committed to Git
- ✅ Railway deployment files ready

---

## Step 1: Push to GitHub (5 minutes)

### 1.1 Create GitHub Repository

1. Go to https://github.com/new
2. Repository name: `thumbtack-bridge`
3. Description: "Backend API service for Thumbtack integration"
4. **Private** (recommended) ✅
5. **Don't** initialize with README
6. Click **Create repository**

### 1.2 Push Your Code

```bash
# Check remote (if needed, remove old origin)
git remote -v

# If origin exists and points to wrong repo:
git remote remove origin

# Add your new GitHub repository
git remote add origin https://github.com/YOUR_USERNAME/thumbtack-bridge.git

# Push to GitHub
git push -u origin main
```

✅ **Done!** Your code is now on GitHub.

---

## Step 2: Deploy to Railway (10 minutes)

### 2.1 Sign Up & Connect

1. Go to https://railway.app
2. Click **Login with GitHub**
3. Authorize Railway to access your repositories

### 2.2 Create New Project

1. Click **New Project**
2. Select **Deploy from GitHub repo**
3. Search for and select `thumbtack-bridge`
4. Click **Deploy Now**

Railway will automatically:
- Detect Node.js project ✅
- Run `npm install` ✅
- Run `npm run build` ✅
- Start with `npm run start:prod` ✅

Wait 2-3 minutes for deployment to complete.

### 2.3 Add Environment Variables

Click on your service → **Variables** tab → **+ New Variable**

Add these (copy from your local `.env` file):

```bash
DATABASE_URL=postgresql://postgres:t.9NBT8K4Vd4f%3F%2B@db.eeeipuztpbubslsxcpew.supabase.co:5432/postgres

DIRECT_URL=postgresql://postgres.eeeipuztpbubslsxcpew:t.9NBT8K4Vd4f%3F%2B@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true

PORT=3000

NODE_ENV=production

JWT_SECRET=ab8970cda0673938447af748aac9a762804b8a73a6262be2f13b56a549a8beb1

JWT_EXPIRES_IN=7d

ENCRYPTION_KEY=ab239ea38eb6e064cbf0972058435c4f
```

**Don't add Thumbtack credentials yet** - you'll get those after approval.

Click **Deploy** to restart with new variables.

### 2.4 Get Your Railway Domain

1. Go to **Settings** → **Domains**
2. Copy your domain (looks like: `thumbtack-bridge-production.up.railway.app`)
3. **Save this URL!** You need it for Thumbtack application.

### 2.5 Test Your Deployment

```powershell
# Test API is running
Invoke-RestMethod -Uri "https://YOUR_RAILWAY_DOMAIN.up.railway.app/api/auth/profile"

# Should return: {"statusCode":401,"message":"Unauthorized"}
# ✅ This means the API is running!
```

✅ **Done!** Your API is live on Railway.

---

## Step 3: Apply for Thumbtack API Access (5 minutes)

Now you have a professional production URL! Fill out the form:

### Go to Thumbtack Developer Portal

Visit: https://www.thumbtack.com/developers

### Fill Out Application Form

#### Technical Info

**Years of experience implementing OAuth based APIs:**
```
Less than 1 year
```

**Development environments:**
```
✓ Production
✓ Development
✓ Local
```

#### Setup Info

**Client URI** (Homepage):
```
https://YOUR_RAILWAY_DOMAIN.up.railway.app
```

**Redirect URIs** (one per line):
```
https://YOUR_RAILWAY_DOMAIN.up.railway.app/api/v1/thumbtack/auth/callback
http://localhost:3000/api/v1/thumbtack/auth/callback
```

**Contacts**:
```
your-email@example.com
```

**Logo URI** (optional - leave blank for now):
```
(empty)
```

**Policy URI** (optional - leave blank for now):
```
(empty)
```

**Terms of Service URI** (optional - leave blank for now):
```
(empty)
```

#### Agreement

- ✅ Check: "I have read, understand, and agree to be bound to Thumbtack's API Terms of Use"

Click **Submit Application**

✅ **Done!** Application submitted.

---

## Step 4: Wait for Thumbtack Approval (1-3 business days)

Thumbtack will review your application and send you:
- `THUMBTACK_CLIENT_ID`
- `THUMBTACK_CLIENT_SECRET`
- `THUMBTACK_WEBHOOK_SECRET`

Check your email regularly!

---

## Step 5: After Approval - Configure Thumbtack (5 minutes)

### 5.1 Add Credentials to Railway

Go to Railway → Your Service → **Variables**

Add:
```
THUMBTACK_CLIENT_ID=your-client-id-from-thumbtack

THUMBTACK_CLIENT_SECRET=your-client-secret-from-thumbtack

THUMBTACK_REDIRECT_URI=https://YOUR_RAILWAY_DOMAIN.up.railway.app/api/v1/thumbtack/auth/callback

THUMBTACK_WEBHOOK_SECRET=your-webhook-secret-from-thumbtack
```

Click **Deploy** to restart.

### 5.2 Configure Webhooks

In Thumbtack Developer Dashboard:

**Webhook URL**:
```
https://YOUR_RAILWAY_DOMAIN.up.railway.app/api/webhooks/thumbtack
```

**Events** (select all):
- ✓ Lead received
- ✓ Message received
- ✓ Quote status changed
- ✓ All other available events

**Webhook Secret**: (Already in Railway variables)

Save configuration.

### 5.3 Test OAuth Flow

```powershell
# Get your token from registration
$body = @{
    email = "you@example.com"
    password = "YourPassword123!"
    name = "Your Name"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "https://YOUR_RAILWAY_DOMAIN.up.railway.app/api/auth/register" `
    -Method Post `
    -ContentType "application/json" `
    -Body $body

$token = $response.token

# Get OAuth URL
$headers = @{ "Authorization" = "Bearer $token" }
$authUrl = Invoke-RestMethod -Uri "https://YOUR_RAILWAY_DOMAIN.up.railway.app/api/v1/thumbtack/auth/url" `
    -Method Get `
    -Headers $headers

# Open in browser
Start-Process $authUrl.authUrl
```

Follow the OAuth flow to connect your Thumbtack account!

✅ **Done!** You're live and receiving leads.

---

## Complete Checklist

- [ ] Push code to GitHub
- [ ] Deploy to Railway
- [ ] Add environment variables to Railway
- [ ] Get Railway domain URL
- [ ] Test deployed API
- [ ] Submit Thumbtack application with Railway URL
- [ ] Wait for approval (1-3 days)
- [ ] Add Thumbtack credentials to Railway
- [ ] Configure webhooks in Thumbtack
- [ ] Test OAuth flow
- [ ] Connect Thumbtack account
- [ ] Start receiving leads! 🎉

---

## Quick Commands Reference

### Test Production API

```powershell
# Register user
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

# Get profile
$headers = @{ "Authorization" = "Bearer $token" }
Invoke-RestMethod -Uri "https://YOUR_RAILWAY_DOMAIN.up.railway.app/api/auth/profile" `
    -Method Get `
    -Headers $headers

# Get all leads
Invoke-RestMethod -Uri "https://YOUR_RAILWAY_DOMAIN.up.railway.app/api/v1/leads" `
    -Method Get `
    -Headers $headers
```

---

## Need Help?

📖 **Detailed Guides**:
- [RAILWAY_DEPLOYMENT.md](./RAILWAY_DEPLOYMENT.md) - Complete Railway deployment guide
- [DEPLOYMENT_CHECKLIST.md](./DEPLOYMENT_CHECKLIST.md) - Step-by-step checklist
- [POWERSHELL_GUIDE.md](./POWERSHELL_GUIDE.md) - PowerShell API testing commands

📧 **Support**:
- Railway: https://railway.app/help
- Thumbtack API: Check developer portal documentation

---

**You're almost there!** Just deploy, apply, and start managing leads! 🚀
