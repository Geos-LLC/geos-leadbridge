# API Testing Examples

This document provides example API calls for testing the Thumbtack Bridge API.

## Prerequisites

1. Start the server: `npm run start:dev`
2. Have a PostgreSQL database running and configured in `.env`
3. Use a tool like Postman, Insomnia, or cURL

## 1. User Registration & Authentication

### Register a New User

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@example.com",
    "password": "SecurePassword123!",
    "name": "John Doe"
  }'
```

Response:
```json
{
  "user": {
    "id": "uuid-here",
    "email": "john@example.com",
    "name": "John Doe"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Save the token** - you'll need it for authenticated requests!

### Login

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@example.com",
    "password": "SecurePassword123!"
  }'
```

### Get User Profile

```bash
curl -X GET http://localhost:3000/api/auth/profile \
  -H "Authorization: Bearer YOUR_JWT_TOKEN_HERE"
```

## 2. Connect Thumbtack Account

### Step 1: Get OAuth Authorization URL

```bash
curl -X GET http://localhost:3000/api/v1/thumbtack/auth/url \
  -H "Authorization: Bearer YOUR_JWT_TOKEN_HERE"
```

Response:
```json
{
  "authUrl": "https://www.thumbtack.com/api/oauth2/authorize?client_id=XXX&redirect_uri=YYY&..."
}
```

### Step 2: User Visits Auth URL
Direct the user to the `authUrl` in their browser. After they authorize, Thumbtack redirects to your callback URL with a `code` parameter.

### Step 3: Exchange Code for Tokens

```bash
curl -X POST http://localhost:3000/api/v1/thumbtack/auth/connect \
  -H "Authorization: Bearer YOUR_JWT_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "AUTHORIZATION_CODE_FROM_CALLBACK"
  }'
```

Response:
```json
{
  "success": true,
  "message": "Thumbtack account connected successfully"
}
```

## 3. Fetch Leads

### Get Leads from Thumbtack

```bash
curl -X GET "http://localhost:3000/api/v1/thumbtack/leads?limit=10" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN_HERE"
```

Response:
```json
{
  "platform": "thumbtack",
  "count": 5,
  "leads": [
    {
      "id": "internal-uuid",
      "platform": "thumbtack",
      "externalRequestId": "thumbtack-request-123",
      "customerName": "Jane Smith",
      "customerPhone": "+1234567890",
      "customerEmail": "jane@example.com",
      "message": "I need help with lawn mowing",
      "budget": 100.00,
      "postcode": "94103",
      "city": "San Francisco",
      "state": "CA",
      "category": "Lawn Care",
      "status": "new",
      "threadId": "thread-123",
      "createdAt": "2025-12-11T10:00:00Z",
      "updatedAt": "2025-12-11T10:00:00Z"
    }
  ]
}
```

### Get All Leads from All Connected Platforms

```bash
curl -X GET "http://localhost:3000/api/v1/leads?status=new&limit=50" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN_HERE"
```

### Get Cached Leads (from database)

```bash
curl -X GET "http://localhost:3000/api/v1/leads?platform=thumbtack&limit=20" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN_HERE"
```

### Get Single Lead by ID

```bash
curl -X GET http://localhost:3000/api/v1/leads/LEAD_UUID_HERE \
  -H "Authorization: Bearer YOUR_JWT_TOKEN_HERE"
```

## 4. Send Messages & Quotes

### Send Message to Lead

```bash
curl -X POST http://localhost:3000/api/v1/leads/LEAD_UUID_HERE/message \
  -H "Authorization: Bearer YOUR_JWT_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hi Jane! Thank you for reaching out. I would be happy to help with your lawn care needs. I have 10 years of experience and can provide excellent service. When would be a good time for you?"
  }'
```

### Send Quote to Lead

```bash
curl -X POST http://localhost:3000/api/v1/leads/LEAD_UUID_HERE/quote \
  -H "Authorization: Bearer YOUR_JWT_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 150.00,
    "description": "Weekly lawn mowing service including edging and cleanup"
  }'
```

### Update Lead Status

```bash
curl -X PATCH http://localhost:3000/api/v1/leads/LEAD_UUID_HERE/status \
  -H "Authorization: Bearer YOUR_JWT_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "contacted"
  }'
```

## 5. Webhooks

### Simulate Thumbtack Webhook (for testing)

```bash
curl -X POST http://localhost:3000/api/webhooks/thumbtack \
  -H "Content-Type: application/json" \
  -H "x-thumbtack-signature: test-signature-here" \
  -d '{
    "event_type": "request.created",
    "request_id": "12345",
    "customer": {
      "name": "Test Customer",
      "email": "test@example.com",
      "phone": "+1234567890"
    },
    "message": "I need help with plumbing",
    "category": "Plumbing",
    "created_at": "2025-12-11T10:00:00Z"
  }'
```

### Get Webhook Event Log (for debugging)

```bash
curl -X GET "http://localhost:3000/api/webhooks/events?platform=thumbtack&limit=20" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN_HERE"
```

## 6. Disconnect Platform

```bash
curl -X POST http://localhost:3000/api/v1/thumbtack/auth/disconnect \
  -H "Authorization: Bearer YOUR_JWT_TOKEN_HERE"
```

## Testing with Postman

1. Import the collection into Postman
2. Create an environment with variable `jwt_token`
3. After login/register, set the token in the environment
4. All subsequent requests will use the token automatically

## Environment Variables

Make sure your `.env` file has:

```
DATABASE_URL="postgresql://user:password@localhost:5432/thumbtack_bridge"
JWT_SECRET="your-super-secret-jwt-key"
ENCRYPTION_KEY="your-32-character-encryption-key"
THUMBTACK_CLIENT_ID="your-thumbtack-client-id"
THUMBTACK_CLIENT_SECRET="your-thumbtack-client-secret"
```

## Common HTTP Status Codes

- `200 OK` - Request successful
- `201 Created` - Resource created successfully
- `400 Bad Request` - Invalid request data
- `401 Unauthorized` - Missing or invalid JWT token
- `404 Not Found` - Resource not found
- `409 Conflict` - Resource already exists (e.g., email already registered)
- `500 Internal Server Error` - Server error

## Tips

1. **Always include the Authorization header** for protected endpoints
2. **JWT tokens expire** - if you get 401, login again to get a new token
3. **Test webhooks** using a tool like ngrok to expose your local server to Thumbtack
4. **Use Prisma Studio** (`npm run prisma:studio`) to view/edit database records visually
5. **Check server logs** for detailed error messages during development
