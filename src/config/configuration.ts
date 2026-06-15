/**
 * Application Configuration
 * Loads and validates environment variables
 */

function requiredEnv(name: string, minLength = 1): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  if (value.length < minLength) {
    throw new Error(
      `Environment variable ${name} is too short (got ${value.length} chars, need >=${minLength})`,
    );
  }
  return value;
}

export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  database: {
    url: process.env.DATABASE_URL,
  },

  jwt: {
    secret: requiredEnv('JWT_SECRET', 32),
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  encryption: {
    key: requiredEnv('ENCRYPTION_KEY', 32),
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

  cache: {
    // Master kill switch. Set CACHE_ENABLED=false to disable Redis without a code change.
    enabled: process.env.CACHE_ENABLED !== 'false',
    // Railway auto-injects REDIS_URL when a Redis plugin is attached.
    redisUrl: process.env.REDIS_URL,
    // Env-scoped key prefix — lets staging and prod safely share one Redis instance.
    keyPrefix: `lb:v1:${process.env.NODE_ENV || 'development'}:`,
  },

  // Feature flags reserved for the DB-first / hot-window cache rollout.
  // Each flips an independent later-phase code path. All default false so this
  // PR is a no-op behavior-wise; later phases gate their changes on these.
  features: {
    // Phase 1.1 — extend handleYelpNewEventInner to persist every event from
    // the classifier fetch (today: only the latest customer message lands).
    yelpWebhookPersistFullThread: process.env.FEATURE_YELP_WEBHOOK_PERSIST_FULL_THREAD === 'true',
    // Phase 4 — server-driven prewarm endpoint called from the Messages page.
    messagesPrewarm: process.env.FEATURE_MESSAGES_PREWARM === 'true',
  },
});
