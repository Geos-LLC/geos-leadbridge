/**
 * Application Configuration
 * Loads and validates environment variables
 */

export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  database: {
    url: process.env.DATABASE_URL,
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  encryption: {
    key: process.env.ENCRYPTION_KEY || 'your-32-character-encryption-key',
  },

  thumbtack: {
    clientId: process.env.THUMBTACK_CLIENT_ID,
    clientSecret: process.env.THUMBTACK_CLIENT_SECRET,
    redirectUri: process.env.THUMBTACK_REDIRECT_URI || 'http://localhost:3000/v1/thumbtack/auth/callback',
    webhookSecret: process.env.THUMBTACK_WEBHOOK_SECRET,
    apiBaseUrl: 'https://api.thumbtack.com/api/v4',
    authBaseUrl: 'https://auth.thumbtack.com/oauth2',
  },

  yelp: {
    apiKey: process.env.YELP_API_KEY,
    clientId: process.env.YELP_CLIENT_ID,
    clientSecret: process.env.YELP_CLIENT_SECRET,
    redirectUri: process.env.YELP_REDIRECT_URI || 'http://localhost:3000/api/v1/yelp/auth/callback',
    webhookSecret: process.env.YELP_WEBHOOK_SECRET,
    apiBaseUrl: 'https://api.yelp.com/v3',
  },

  sigcore: {
    apiUrl: process.env.SIGCORE_API_URL || 'https://sigcore-production.up.railway.app',
    apiKey: process.env.SIGCORE_API_KEY,
    // HMAC secret for verifying incoming call-connect webhooks from Sigcore
    callConnectWebhookSecret: process.env.SIGCORE_CALL_CONNECT_WEBHOOK_SECRET,
  },

  // Public base URL of this app — used to build webhook callback URLs sent to Sigcore
  appBaseUrl: process.env.APP_BASE_URL || process.env.FRONTEND_URL || 'https://leadbridge360.com',
});
