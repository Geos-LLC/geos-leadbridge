# Thumbtack Bridge API

A multi-platform lead integration service that connects Thumbtack, Yelp, and other lead generation platforms into a unified API. Built with NestJS, TypeScript, and Supabase (PostgreSQL).

## Features

- **Multi-Platform Support**: Extensible adapter pattern for integrating multiple platforms (Thumbtack, Yelp, Angi, etc.)
- **OAuth 2.0 Authentication**: Secure connection to platform accounts
- **Unified API**: Single interface for leads, messages, and quotes across all platforms
- **Real-time Webhooks**: Receive instant updates when new leads arrive or messages are sent
- **Encrypted Credentials**: Military-grade encryption for storing OAuth tokens
- **JWT Authentication**: Secure API access for your web/mobile apps
- **Database Caching**: PostgreSQL storage for offline access and fast queries
- **Future-proof Architecture**: Easily add new platforms without refactoring

## Tech Stack

- **Runtime**: Node.js 18+ with TypeScript
- **Framework**: NestJS
- **Database**: Supabase (PostgreSQL) with Prisma ORM
- **Authentication**: Passport JWT
- **Encryption**: AES-256-GCM
- **API Style**: RESTful

## Quick Start

### Prerequisites

- Node.js 18 or higher
- Supabase account (free tier available at https://supabase.com)
- Thumbtack Developer Account (for API credentials)

📖 **See [SUPABASE_SETUP.md](./SUPABASE_SETUP.md) for detailed database setup instructions**

### Installation

1. Clone the repository and install dependencies:

```bash
npm install
```

2. Set up environment variables:

```bash
cp .env.example .env
```

Edit `.env` and configure:
- `DATABASE_URL`: Supabase connection pooling URL (get from Supabase dashboard)
- `DIRECT_URL`: Supabase direct connection URL (for migrations)
- `JWT_SECRET`: Secret key for JWT tokens
- `ENCRYPTION_KEY`: 32-character key for encrypting OAuth tokens
- `THUMBTACK_CLIENT_ID`: Your Thumbtack OAuth client ID
- `THUMBTACK_CLIENT_SECRET`: Your Thumbtack OAuth client secret
- `THUMBTACK_WEBHOOK_SECRET`: Webhook verification secret

3. Set up Supabase database:

```bash
# Generate Prisma client
npm run prisma:generate

# Run database migrations (creates tables in Supabase)
npm run prisma:migrate
```

📖 **Need help?** See [SUPABASE_SETUP.md](./SUPABASE_SETUP.md) for step-by-step Supabase configuration

4. Start the development server:

```bash
npm run start:dev
```

The server will start on `http://localhost:3000`

## API Documentation

### Authentication Endpoints

#### Register a new user
```http
POST /api/auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "secure_password",
  "name": "John Doe"
}
```

#### Login
```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "secure_password"
}
```

Returns:
```json
{
  "user": { "id": "...", "email": "...", "name": "..." },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

#### Get Profile
```http
GET /api/auth/profile
Authorization: Bearer <your_jwt_token>
```

### Thumbtack Integration

#### Get OAuth URL
```http
GET /api/v1/thumbtack/auth/url
Authorization: Bearer <your_jwt_token>
```

Returns: `{ "authUrl": "https://www.thumbtack.com/api/oauth2/authorize?..." }`

#### Connect Thumbtack Account
After user authorizes, exchange the code:
```http
POST /api/v1/thumbtack/auth/connect
Authorization: Bearer <your_jwt_token>
Content-Type: application/json

{
  "code": "authorization_code_from_callback"
}
```

#### Get Leads from Thumbtack
```http
GET /api/v1/thumbtack/leads?limit=50&since=2025-01-01
Authorization: Bearer <your_jwt_token>
```

#### Send Message to Lead
```http
POST /api/v1/thumbtack/leads/:leadId/message
Authorization: Bearer <your_jwt_token>
Content-Type: application/json

{
  "message": "Thank you for your inquiry! I'd be happy to help."
}
```

#### Send Quote to Lead
```http
POST /api/v1/thumbtack/leads/:leadId/quote
Authorization: Bearer <your_jwt_token>
Content-Type: application/json

{
  "amount": 150.00,
  "description": "Quote for lawn mowing service"
}
```

### Unified Endpoints (All Platforms)

#### Get All Leads
```http
GET /api/v1/leads?platform=thumbtack&status=new&limit=50
Authorization: Bearer <your_jwt_token>
```

Returns leads from all connected platforms in a normalized format.

### Webhooks

Thumbtack will send webhooks to:
```
POST /api/webhooks/thumbtack
```

Make sure to configure this URL in your Thumbtack developer dashboard.

## Database Schema

The application uses a normalized schema that supports multiple platforms:

- **users**: Your app users
- **platforms**: Connected platform accounts (Thumbtack, Yelp, etc.)
- **leads**: Normalized leads from all platforms
- **conversations**: Message threads
- **messages**: Individual messages
- **quotes**: Sent quotes and their status
- **webhook_events**: Webhook event log

## Architecture

### Platform Adapter Pattern

Each platform (Thumbtack, Yelp, etc.) has its own adapter that implements the `IPlatformAdapter` interface:

```typescript
interface IPlatformAdapter {
  getAuthUrl(userId: string, state: string): string;
  handleCallback(code: string, userId: string): Promise<PlatformCredentials>;
  getLeads(credentials: PlatformCredentials): Promise<NormalizedLead[]>;
  sendMessage(credentials: PlatformCredentials, threadId: string, message: string): Promise<NormalizedMessage>;
  // ... and more
}
```

This ensures that adding a new platform is straightforward:

1. Create a new adapter implementing `IPlatformAdapter`
2. Add it to the `PlatformFactory`
3. Done! All endpoints automatically support the new platform

### Data Normalization

All platform-specific data is converted to normalized formats:
- `NormalizedLead`
- `NormalizedConversation`
- `NormalizedMessage`
- `NormalizedQuote`

This allows your frontend and CRM to work with a single, consistent data structure regardless of the platform.

## Security

- **OAuth tokens** are encrypted at rest using AES-256-GCM
- **Passwords** are hashed with bcrypt
- **Webhook signatures** are verified using HMAC-SHA256
- **API endpoints** are protected with JWT authentication
- **Input validation** using class-validator

## Adding a New Platform (e.g., Yelp)

1. Create `src/platforms/yelp/yelp.adapter.ts` implementing `IPlatformAdapter`
2. Add YelpAdapter to `PlatformFactory`
3. Create `src/platforms/yelp/yelp.controller.ts` (optional, for platform-specific endpoints)
4. Add Yelp configuration to `src/config/configuration.ts`
5. Update `.env.example` with Yelp credentials

That's it! Your unified `/api/v1/leads` endpoint will now include Yelp leads.

## Deployment

### Environment Variables for Production

```bash
DATABASE_URL="postgresql://user:password@host:5432/thumbtack_bridge"
JWT_SECRET="use-a-long-random-string-in-production"
ENCRYPTION_KEY="use-a-32-character-random-string"
THUMBTACK_CLIENT_ID="your_production_client_id"
THUMBTACK_CLIENT_SECRET="your_production_client_secret"
THUMBTACK_REDIRECT_URI="https://api.yourcompany.com/api/v1/thumbtack/auth/callback"
THUMBTACK_WEBHOOK_SECRET="your_webhook_secret"
NODE_ENV=production
```

### Deploy to Railway

```bash
# Build the app
npm run build

# Set environment variables in Railway dashboard
# Deploy using Railway CLI or GitHub integration
```

## Development

### Project Structure

```
src/
├── auth/                 # Authentication module
├── common/               # Shared utilities, guards, decorators
│   ├── decorators/       # Custom decorators
│   ├── dto/              # Normalized DTOs
│   ├── guards/           # Auth guards
│   ├── interfaces/       # Platform interface
│   └── utils/            # Encryption, Prisma service
├── config/               # Configuration
├── leads/                # Leads module (unified endpoints)
├── platforms/            # Platform adapters
│   ├── thumbtack/        # Thumbtack adapter
│   └── yelp/             # Yelp adapter (future)
└── webhooks/             # Webhook handlers
```

### Scripts

- `npm run start:dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm run start:prod` - Start production server
- `npm run prisma:migrate` - Run database migrations
- `npm run prisma:studio` - Open Prisma Studio (database GUI)

## License

MIT

## Support

For issues and questions, please open a GitHub issue.
