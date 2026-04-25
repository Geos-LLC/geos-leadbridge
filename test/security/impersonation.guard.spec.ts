/**
 * Impersonation guard — Phase 0 security hotfix
 *
 * Before Phase 0 only non-GET requests were logged while an admin
 * impersonated a user, so silent reads of customer data left no trail.
 * Regression check: GET (and other read) methods also emit a log line
 * that identifies the admin, the target, and the route.
 */

import { ExecutionContext } from '@nestjs/common';
import { ImpersonationGuard } from '../../src/common/guards/impersonation.guard';

function buildContext(method: string, headers: Record<string, string>, user: any): ExecutionContext {
  const request = {
    method,
    headers,
    url: '/v1/conversation-context/conv-1',
    user,
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as any;
}

describe('ImpersonationGuard — audit logging', () => {
  const admin = { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' };
  const target = {
    id: 'user-target',
    email: 'target@example.com',
    name: 'Target',
    role: 'USER',
    subscriptionTier: null,
    subscriptionStatus: null,
    subscriptionPeriodEnd: null,
    hasOwnNumber: false,
  };

  let prisma: any;
  let reflector: any;
  let guard: ImpersonationGuard;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn().mockResolvedValue(target) } };
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    guard = new ImpersonationGuard(prisma, reflector);
    // Silence and spy on the NestJS logger
    logSpy = jest.spyOn((guard as any).logger, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('logs GET requests as "read" when an admin impersonates', async () => {
    const ctx = buildContext('GET', { 'x-impersonate-user': target.id }, admin);
    const ok = await guard.canActivate(ctx);
    expect(ok).toBe(true);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [message] = logSpy.mock.calls[0];
    expect(message).toContain('read');
    expect(message).toContain(admin.email);
    expect(message).toContain(target.email);
    expect(message).toContain('GET');
  });

  it('logs POST requests as "write" when an admin impersonates', async () => {
    const ctx = buildContext('POST', { 'x-impersonate-user': target.id }, admin);
    await guard.canActivate(ctx);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [message] = logSpy.mock.calls[0];
    expect(message).toContain('write');
    expect(message).toContain('POST');
  });

  it('does not log when no impersonation header is present', async () => {
    const ctx = buildContext('GET', {}, admin);
    await guard.canActivate(ctx);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('does not log when the caller is not an admin', async () => {
    const nonAdmin = { ...admin, role: 'USER' };
    const ctx = buildContext('GET', { 'x-impersonate-user': target.id }, nonAdmin);
    await guard.canActivate(ctx);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
