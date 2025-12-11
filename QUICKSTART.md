# Quick Start Guide

Get your Thumbtack Bridge API up and running in 10 minutes!

## Step 1: Prerequisites

Make sure you have:
- ✅ Node.js 18+ installed
- ✅ A Supabase account (free tier available at https://supabase.com)
- ✅ A Thumbtack Developer account (sign up at https://www.thumbtack.com/developers)

## Step 2: Install Dependencies

```bash
npm install
```

## Step 3: Set Up Supabase Database

1. Go to https://app.supabase.com and create a new project
2. Wait for the database to be provisioned (~2 minutes)
3. Go to **Settings** → **Database**
4. Copy both connection strings:
   - **Connection pooling** (with pgbouncer) for `DATABASE_URL`
   - **Direct connection** for `DIRECT_URL`

## Step 4: Configure Environment

1. Copy the example environment file:
```bash
cp .env.example .env
```

2. Edit `.env` and update these critical values:

```bash
# Supabase Database - Get from https://app.supabase.com/project/_/settings/database
DATABASE_URL="postgresql://postgres:[YOUR-PASSWORD]@db.xxxxx.supabase.co:6543/postgres?pgbouncer=true"
DIRECT_URL="postgresql://postgres:[YOUR-PASSWORD]@db.xxxxx.supabase.co:5432/postgres"

# Security - Generate secure random strings
JWT_SECRET="your-long-random-secret-at-least-32-chars"
ENCRYPTION_KEY="exactly-32-character-string-here"

# Thumbtack - Get these from https://www.thumbtack.com/developers
THUMBTACK_CLIENT_ID="your_client_id_here"
THUMBTACK_CLIENT_SECRET="your_client_secret_here"
THUMBTACK_WEBHOOK_SECRET="your_webhook_secret_here"
```

### How to Generate Secure Keys

For JWT_SECRET and ENCRYPTION_KEY, use these commands:

```bash
# JWT Secret (any length)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Encryption Key (must be exactly 32 chars)
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

## Step 5: Set Up Database Schema

1. Generate Prisma client:
```bash
npm run prisma:generate
```

2. Run migrations to create tables in Supabase:
```bash
npm run prisma:migrate
```

This will create all 8 tables in your Supabase database:
- ✅ users
- ✅ platforms
- ✅ leads
- ✅ conversations
- ✅ messages
- ✅ quotes
- ✅ webhook_events

You can view your tables in the Supabase dashboard under **Table Editor**.

## Step 6: Start the Server

Development mode (with hot reload):
```bash
npm run start:dev
```

Production mode:
```bash
npm run build
npm run start:prod
```

You should see:
```
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   🌉 Thumbtack Bridge API Server                     ║
║                                                       ║
║   Server running on: http://localhost:3000           ║
║   Environment: development                            ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
```

## Step 7: Test the API

### 1. Register a User

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "Test123!",
    "name": "Test User"
  }'
```

Save the returned `token`!

### 2. Get Your Profile

```bash
curl -X GET http://localhost:3000/api/auth/profile \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

### 3. Connect Thumbtack

Get the OAuth URL:
```bash
curl -X GET http://localhost:3000/api/v1/thumbtack/auth/url \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

Visit the returned `authUrl` in your browser, authorize, and then use the code to connect:

```bash
curl -X POST http://localhost:3000/api/v1/thumbtack/auth/connect \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"code": "CODE_FROM_CALLBACK"}'
```

### 4. Fetch Leads

```bash
curl -X GET http://localhost:3000/api/v1/thumbtack/leads \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

## Useful Commands

### Database Management

```bash
# Open Prisma Studio (visual database editor)
npm run prisma:studio

# Create a new migration
npm run prisma:migrate

# Reset database (WARNING: deletes all data)
npx prisma migrate reset
```

### Development

```bash
# Start dev server
npm run start:dev

# Build for production
npm run build

# Run production build
npm run start:prod
```

## Troubleshooting

### "Cannot connect to database"
- Check your Supabase connection strings in `.env`
- Make sure you copied both `DATABASE_URL` and `DIRECT_URL`
- Verify your Supabase project is active (not paused)
- Check if you replaced `[YOUR-PASSWORD]` with your actual database password

### "Unauthorized" errors
- Make sure you're including the JWT token in the Authorization header
- Check that JWT_SECRET matches between registration and login

### "Platform not connected"
- Complete the OAuth flow first by calling `/v1/thumbtack/auth/url`
- Make sure THUMBTACK_CLIENT_ID and THUMBTACK_CLIENT_SECRET are correct

### Webhooks not working
- Thumbtack webhooks require a public URL
- Use ngrok for local testing: `ngrok http 3000`
- Configure the ngrok URL in Thumbtack developer dashboard

## Next Steps

1. ✅ Read the full [API_EXAMPLES.md](./API_EXAMPLES.md) for all available endpoints
2. ✅ Review [README.md](./README.md) for architecture details
3. ✅ Add more platforms (Yelp, Angi, etc.) using the adapter pattern
4. ✅ Deploy to production (Railway, Heroku, AWS, etc.)

## Need Help?

- 📖 Check the [README.md](./README.md) for detailed documentation
- 🔍 See [API_EXAMPLES.md](./API_EXAMPLES.md) for more API examples
- 🐛 Open an issue on GitHub if you encounter problems

Enjoy building with Thumbtack Bridge! 🎉
