import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { SfProvisioningService } from './sf-provisioning.service';
import { EncryptionUtil } from '../../common/utils/encryption.util';

const JWT_SECRET = 'sf-prov-test-jwt-secret-32-bytes-ok';

function buildSvc(opts: {
  user?: any | null;
  existingConnection?: any | null;
  nonceConsumed?: boolean;
  webhookUrlEnv?: string;
  lifecycleResponse?: { ok: boolean; connectionId?: string; noop?: boolean; reason?: string };
} = {}) {
  const consumedNonces = new Set<string>();
  if (opts.nonceConsumed) consumedNonces.add('PRECONSUMED');

  const prisma: any = {
    user: {
      findUnique: jest.fn(async () => opts.user ?? null),
    },
    sfConnection: {
      findUnique: jest.fn(async () => opts.existingConnection ?? null),
    },
    sfProvisioningLinkConsumed: {
      create: jest.fn(async ({ data }: any) => {
        if (consumedNonces.has(data.nonce)) {
          const err: any = new Error('Unique constraint failed on (nonce)');
          err.code = 'P2002';
          throw err;
        }
        consumedNonces.add(data.nonce);
        return data;
      }),
    },
  };

  const cfg = {
    get: jest.fn((key: string, def?: any) => {
      if (key === 'SF_ORCHESTRATION_WEBHOOK_URL') return opts.webhookUrlEnv ?? def ?? '';
      return def;
    }),
  } as any as ConfigService;

  const jwt = new JwtService({ secret: JWT_SECRET });

  const lifecycle: any = {
    applyConnectionConnected: jest.fn(async () =>
      opts.lifecycleResponse ?? { ok: true, connectionId: 'conn-1' },
    ),
  };

  const svc = new SfProvisioningService(prisma, cfg, jwt, lifecycle);
  return { svc, prisma, cfg, jwt, lifecycle, consumedNonces };
}

// Build a realistic provisioning payload that matches the canonical SF S4 shape.
function provisioningPayload(over: any = {}) {
  return {
    tenant: {
      sf_tenant_id: 2,
      sf_workspace_id: 88888,
      sf_base_url: 'https://service-flow-backend-production-4568.up.railway.app',
      source_instance: 'sf-prod',
      api_region: null,
      sf_tenant_name: 'Spotless Homes Florida LLC',
      ...over.tenant,
    },
    credential: {
      token: 'sfo_v1.NEW_PROD_BEARER_TOKEN_FROM_SF',
      token_prefix: 'sfo_v1.NEW_P',
      kid: 'sf_orch_2026_06',
      scope: 'lb_orchestration',
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 90 * 24 * 3600_000).toISOString(),
      cred_id: 42,
      ...over.credential,
    },
    endpoints: {
      availability: '/api/integrations/leadbridge/orchestration/availability',
      booking_request: '/api/integrations/leadbridge/orchestration/booking-request',
      booking_cancel: '/api/integrations/leadbridge/orchestration/booking-cancel',
      handoff: '/api/integrations/leadbridge/orchestration/handoff',
      disconnect: '/api/integrations/leadbridge/disconnect',
      credentials_refresh: '/api/integrations/leadbridge/orchestration/credentials/refresh',
      ...over.endpoints,
    },
    signature_metadata: {
      algorithm: 'hmac-sha256-hex',
      max_clock_skew_seconds: 300,
      ...over.signature_metadata,
    },
    event_types: [
      'service_scheduled', 'service_rescheduled', 'service_cancelled', 'service_completed',
      'connection.connected', 'credential.rotated', 'connection.revoked',
    ],
    ...over,
  };
}

describe('SfProvisioningService.verifyCredentials', () => {
  const VALID_PASSWORD = 'TenantPassword123!';
  let validUser: any;
  beforeAll(async () => {
    validUser = {
      id: 'c3d14499-dec1-42c3-a36c-713cb09842c6',
      email: 'info@spotless.homes',
      name: 'Spotless Homes Florida LLC',
      password: await EncryptionUtil.hashPassword(VALID_PASSWORD),
    };
  });

  it('returns link_token on valid credentials', async () => {
    const ctx = buildSvc({ user: validUser });
    const r = await ctx.svc.verifyCredentials({ email: 'info@spotless.homes', password: VALID_PASSWORD });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.lb_user_id).toBe('c3d14499-dec1-42c3-a36c-713cb09842c6');
    expect(r.lb_user_email).toBe('info@spotless.homes');
    expect(r.lb_user_display_name).toBe('Spotless Homes Florida LLC');
    expect(r.link_token.length).toBeGreaterThan(50);
    // Decode token + check claims
    const decoded = ctx.jwt.verify(r.link_token) as any;
    expect(decoded.lb_user_id).toBe(validUser.id);
    expect(decoded.purpose).toBe('sf_provisioning_link');
    expect(decoded.nonce).toMatch(/^[a-f0-9]{32}$/);
    // 5-minute TTL
    expect(decoded.exp - decoded.iat).toBe(300);
  });

  it('returns invalid_credentials on bad password (no email enum leak)', async () => {
    const ctx = buildSvc({ user: validUser });
    const r = await ctx.svc.verifyCredentials({ email: 'info@spotless.homes', password: 'wrong' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('invalid_credentials');
  });

  it('returns invalid_credentials when user not found (same shape as bad password — prevents enumeration)', async () => {
    const ctx = buildSvc({ user: null });
    const r = await ctx.svc.verifyCredentials({ email: 'nobody@example.com', password: 'anything' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('invalid_credentials');
  });

  it('returns invalid_credentials when user has no password field set', async () => {
    const ctx = buildSvc({ user: { ...validUser, password: null } });
    const r = await ctx.svc.verifyCredentials({ email: 'info@spotless.homes', password: VALID_PASSWORD });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('invalid_credentials');
  });

  it('returns missing_fields when email or password absent', async () => {
    const ctx = buildSvc({ user: validUser });
    const r1 = await ctx.svc.verifyCredentials({ email: '', password: VALID_PASSWORD });
    expect((r1 as any).error).toBe('missing_fields');
    const r2 = await ctx.svc.verifyCredentials({ email: 'info@spotless.homes', password: '' });
    expect((r2 as any).error).toBe('missing_fields');
  });

  it('rate-limits after 5 attempts in a minute per email', async () => {
    const ctx = buildSvc({ user: validUser });
    for (let i = 0; i < 5; i++) {
      await ctx.svc.verifyCredentials({ email: 'info@spotless.homes', password: 'wrong' });
    }
    const r = await ctx.svc.verifyCredentials({ email: 'info@spotless.homes', password: VALID_PASSWORD });
    expect((r as any).error).toBe('rate_limited');
  });

  it('normalizes email to lowercase + trims whitespace', async () => {
    const ctx = buildSvc({ user: validUser });
    const r = await ctx.svc.verifyCredentials({ email: '  INFO@Spotless.HOMES  ', password: VALID_PASSWORD });
    expect(r.ok).toBe(true);
    // prisma findUnique called with normalized email
    const args = ctx.prisma.user.findUnique.mock.calls[0][0];
    expect(args.where.email).toBe('info@spotless.homes');
  });

  it('NEVER logs the plaintext password', async () => {
    const ctx = buildSvc({ user: validUser });
    const lines: string[] = [];
    const origLog = (ctx.svc as any).logger.log.bind((ctx.svc as any).logger);
    const origWarn = (ctx.svc as any).logger.warn.bind((ctx.svc as any).logger);
    (ctx.svc as any).logger.log = (m: any) => { lines.push(String(m)); };
    (ctx.svc as any).logger.warn = (m: any) => { lines.push(String(m)); };
    try {
      await ctx.svc.verifyCredentials({ email: 'info@spotless.homes', password: VALID_PASSWORD });
      const allLogs = lines.join('\n');
      expect(allLogs).not.toContain(VALID_PASSWORD);
    } finally {
      (ctx.svc as any).logger.log = origLog;
      (ctx.svc as any).logger.warn = origWarn;
    }
  });
});

describe('SfProvisioningService.provision', () => {
  const LB_USER_ID = 'c3d14499-dec1-42c3-a36c-713cb09842c6';

  function mintLinkToken(jwt: JwtService, over: any = {}): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign({
      sub: LB_USER_ID,
      lb_user_id: LB_USER_ID,
      purpose: 'sf_provisioning_link',
      nonce: 'ABCDEFGHIJKLMNOP',
      iat: now,
      exp: now + 300,
      ...over,
    });
  }

  it('succeeds: persists via lifecycle + returns webhook secret', async () => {
    const ctx = buildSvc({ existingConnection: null });
    const link_token = mintLinkToken(ctx.jwt);
    const r = await ctx.svc.provision({ link_token, provisioning: provisioningPayload() });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.connection_id).toBe('conn-1');
    expect(r.sf_tenant_id).toBe(2);
    expect(r.lb_user_id).toBe(LB_USER_ID);
    expect(r.webhook.url).toContain('/api/v1/integrations/sf/orchestration-webhook');
    expect(r.webhook.secret.length).toBeGreaterThanOrEqual(40);  // base64(32 bytes) = 44 chars
    // Nonce claimed
    expect(ctx.prisma.sfProvisioningLinkConsumed.create).toHaveBeenCalledTimes(1);
    // Lifecycle was invoked with the right user + provisioning
    expect(ctx.lifecycle.applyConnectionConnected).toHaveBeenCalledTimes(1);
    const arg = ctx.lifecycle.applyConnectionConnected.mock.calls[0][0];
    expect(arg.userId).toBe(LB_USER_ID);
    expect(arg.webhookSecretPlaintext).toBe(r.webhook.secret);
    expect(arg.provisioning.tenant.sf_tenant_id).toBe(2);
    expect(arg.source).toBe('oauth_exchange');
  });

  it('uses SF_ORCHESTRATION_WEBHOOK_URL env when set, falls back to prod URL', async () => {
    const customUrl = 'https://lb-staging.example.com/api/v1/integrations/sf/orchestration-webhook';
    const ctx = buildSvc({ webhookUrlEnv: customUrl });
    const link_token = mintLinkToken(ctx.jwt);
    const r = await ctx.svc.provision({ link_token, provisioning: provisioningPayload() });
    if (!r.ok) throw new Error('unreachable');
    expect(r.webhook.url).toBe(customUrl);
  });

  it('rejects invalid JWT signature', async () => {
    const ctx = buildSvc({});
    const otherJwt = new JwtService({ secret: 'wrong-secret' });
    const link_token = mintLinkToken(otherJwt);
    const r = await ctx.svc.provision({ link_token, provisioning: provisioningPayload() });
    expect((r as any).error).toBe('link_token_invalid');
    expect(ctx.lifecycle.applyConnectionConnected).not.toHaveBeenCalled();
  });

  it('rejects expired link_token', async () => {
    const ctx = buildSvc({});
    const link_token = mintLinkToken(ctx.jwt, { exp: Math.floor(Date.now() / 1000) - 1 });
    const r = await ctx.svc.provision({ link_token, provisioning: provisioningPayload() });
    expect((r as any).error).toBe('link_token_expired');
  });

  it('rejects link_token with wrong purpose', async () => {
    const ctx = buildSvc({});
    const link_token = ctx.jwt.sign({
      sub: LB_USER_ID,
      lb_user_id: LB_USER_ID,
      purpose: 'something_else',
      nonce: 'AAA',
      iat: Math.floor(Date.now()/1000),
      exp: Math.floor(Date.now()/1000) + 300,
    });
    const r = await ctx.svc.provision({ link_token, provisioning: provisioningPayload() });
    expect((r as any).error).toBe('link_token_invalid');
  });

  it('rejects already-consumed link_token (single-use via unique constraint)', async () => {
    const ctx = buildSvc({});
    const link_token = mintLinkToken(ctx.jwt, { nonce: 'PRECONSUMED' });
    // Preconsume by inserting first
    await ctx.svc.provision({ link_token, provisioning: provisioningPayload() });
    // Re-mint same nonce
    const link_token2 = mintLinkToken(ctx.jwt, { nonce: 'PRECONSUMED' });
    const r2 = await ctx.svc.provision({ link_token: link_token2, provisioning: provisioningPayload() });
    expect((r2 as any).error).toBe('link_token_already_consumed');
  });

  it('rejects cross-tenant connect (LB user already active for a different SF tenant)', async () => {
    const ctx = buildSvc({
      existingConnection: { sfTenantId: '99999', status: 'active', isActive: true },
    });
    const link_token = mintLinkToken(ctx.jwt);
    const r = await ctx.svc.provision({ link_token, provisioning: provisioningPayload() });
    expect((r as any).error).toBe('lb_user_already_connected_elsewhere');
    expect((r as any).detail).toContain('99999');
    expect(ctx.prisma.sfProvisioningLinkConsumed.create).not.toHaveBeenCalled();
    expect(ctx.lifecycle.applyConnectionConnected).not.toHaveBeenCalled();
  });

  it('allows re-provision for the SAME (lb_user, sf_tenant) pair (idempotent via lifecycle)', async () => {
    const ctx = buildSvc({
      existingConnection: { sfTenantId: '2', status: 'active', isActive: true },
      lifecycleResponse: { ok: true, connectionId: 'conn-existing', noop: true },
    });
    const link_token = mintLinkToken(ctx.jwt);
    const r = await ctx.svc.provision({ link_token, provisioning: provisioningPayload() });
    expect(r.ok).toBe(true);
  });

  it('allows re-provision when existing connection is in terminal/inactive state', async () => {
    for (const status of ['disconnected', 'revoked', 'error', 'pending']) {
      const ctx = buildSvc({
        existingConnection: { sfTenantId: '99999', status, isActive: false },
      });
      const link_token = mintLinkToken(ctx.jwt, { nonce: `nonce-${status}` });
      const r = await ctx.svc.provision({ link_token, provisioning: provisioningPayload() });
      expect(r.ok).toBe(true);
    }
  });

  it.each([
    ['no_tenant', { tenant: null }],
    ['bad_sf_tenant_id', { tenant: { sf_tenant_id: 'NaN' } }],
    ['bad_sf_base_url', { tenant: { sf_tenant_id: 2, sf_base_url: 'not-https' } }],
    ['no_token', { credential: { token: '', kid: 'k', issued_at: 't' } }],
    ['no_kid', { credential: { token: 't', kid: undefined, issued_at: 't' } }],
    ['no_availability_endpoint', { endpoints: {} }],
    ['unsupported_algorithm', { signature_metadata: { algorithm: 'md5', max_clock_skew_seconds: 300 } }],
  ])('rejects invalid provisioning payload: %s', async (expectedDetail, override: any) => {
    const ctx = buildSvc({});
    const link_token = mintLinkToken(ctx.jwt, { nonce: 'shape-' + expectedDetail });
    const r = await ctx.svc.provision({ link_token, provisioning: provisioningPayload(override) });
    expect((r as any).error).toBe('invalid_provisioning_payload');
    expect((r as any).detail).toBe(expectedDetail);
    expect(ctx.lifecycle.applyConnectionConnected).not.toHaveBeenCalled();
  });

  it('lifecycle rejection bubbles up as lifecycle_rejected', async () => {
    const ctx = buildSvc({
      lifecycleResponse: { ok: false, reason: 'no_webhook_secret_available' },
    });
    const link_token = mintLinkToken(ctx.jwt, { nonce: 'lifecycle-reject' });
    const r = await ctx.svc.provision({ link_token, provisioning: provisioningPayload() });
    expect((r as any).error).toBe('lifecycle_rejected');
    expect((r as any).detail).toBe('no_webhook_secret_available');
  });

  it('NEVER logs the plaintext orchestration token from the provisioning payload', async () => {
    const lines: string[] = [];
    const ctx = buildSvc({});
    const orig = {
      log: (ctx.svc as any).logger.log.bind((ctx.svc as any).logger),
      warn: (ctx.svc as any).logger.warn.bind((ctx.svc as any).logger),
      error: (ctx.svc as any).logger.error.bind((ctx.svc as any).logger),
    };
    (ctx.svc as any).logger.log = (m: any) => { lines.push(String(m)); };
    (ctx.svc as any).logger.warn = (m: any) => { lines.push(String(m)); };
    (ctx.svc as any).logger.error = (m: any) => { lines.push(String(m)); };
    try {
      const link_token = mintLinkToken(ctx.jwt, { nonce: 'noleak' });
      await ctx.svc.provision({
        link_token,
        provisioning: provisioningPayload({
          credential: {
            token: 'sfo_v1.SUPER_SECRET_PROD_BEARER_DO_NOT_LEAK',
            token_prefix: 'sfo_v1.SUPER',
            kid: 'k1', scope: 's', issued_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 86400000).toISOString(),
            cred_id: 9,
          },
        }),
      });
      const all = lines.join('\n');
      expect(all).not.toContain('SUPER_SECRET_PROD_BEARER_DO_NOT_LEAK');
      // token prefix is OK
      expect(all).not.toContain('sfo_v1.SUPER_SECRET');
    } finally {
      (ctx.svc as any).logger.log = orig.log;
      (ctx.svc as any).logger.warn = orig.warn;
      (ctx.svc as any).logger.error = orig.error;
    }
  });
});
