import { SfConnectionStatusService } from './sf-connection-status.service';

function build(row: any | null) {
  const prisma: any = {
    sfConnection: {
      findUnique: jest.fn(async () => row),
    },
  };
  return { svc: new SfConnectionStatusService(prisma), prisma };
}

describe('SfConnectionStatusService.getStatusForUser', () => {
  it('returns connected=false + status=none when no row exists', async () => {
    const { svc } = build(null);
    const r = await svc.getStatusForUser('u-nobody');
    expect(r.connected).toBe(false);
    expect(r.status).toBe('none');
    expect(r.sfTenantId).toBeNull();
    expect(r.rotationPending).toBe(false);
  });

  it('returns connected=true when isActive + status=active', async () => {
    const { svc } = build({
      isActive: true,
      status: 'active',
      sfTenantId: '99999',
      sfTenantName: 'SF Orch Test',
      sourceInstance: 'sf-staging',
      signatureKeyId: 'sf_orch_2026_05',
      tokenPrefix: 'sfo_v1.eyJ2Ij',
      tokenLastReceivedAt: new Date('2026-05-29T00:19:31Z'),
      tokenExpiresAt: new Date('2026-08-27T00:19:31Z'),
      connectedAt: new Date('2026-05-28T20:44:35Z'),
      disconnectedAt: null,
      disconnectInitiator: null,
      lastErrorMessage: null,
      rotationPending: false,
      pendingRotationGraceExpiresAt: null,
    });
    const r = await svc.getStatusForUser('u1');
    expect(r.connected).toBe(true);
    expect(r.status).toBe('active');
    expect(r.sfTenantId).toBe('99999');
    expect(r.sfTenantName).toBe('SF Orch Test');
    expect(r.signatureKeyId).toBe('sf_orch_2026_05');
    expect(r.tokenPrefix).toBe('sfo_v1.eyJ2Ij');
    expect(r.rotationPending).toBe(false);
  });

  it('returns connected=true when status=rotating (grace window)', async () => {
    const { svc } = build({
      isActive: true, status: 'rotating', sfTenantId: '99999',
      sfTenantName: null, sourceInstance: null, signatureKeyId: null,
      tokenPrefix: null, tokenLastReceivedAt: null, tokenExpiresAt: null,
      connectedAt: new Date(), disconnectedAt: null,
      disconnectInitiator: null, lastErrorMessage: null,
      rotationPending: false, pendingRotationGraceExpiresAt: null,
    });
    const r = await svc.getStatusForUser('u1');
    expect(r.connected).toBe(true);
    expect(r.status).toBe('rotating');
  });

  it('returns connected=false when isActive=false (disconnected/revoked/error)', async () => {
    for (const status of ['disconnected', 'revoked', 'error']) {
      const { svc } = build({
        isActive: false, status,
        sfTenantId: '99999', sfTenantName: null, sourceInstance: null,
        signatureKeyId: null, tokenPrefix: null,
        tokenLastReceivedAt: null, tokenExpiresAt: null,
        connectedAt: new Date(), disconnectedAt: new Date(),
        disconnectInitiator: status === 'revoked' ? 'sf_authority' : 'lb_user',
        lastErrorMessage: status === 'error' ? 'exchange failed' : null,
        rotationPending: false, pendingRotationGraceExpiresAt: null,
      });
      const r = await svc.getStatusForUser('u1');
      expect(r.connected).toBe(false);
      expect(r.status).toBe(status);
    }
  });

  it('returns connected=false when status=pending (handshake in flight)', async () => {
    const { svc } = build({
      isActive: false, status: 'pending',
      sfTenantId: null, sfTenantName: null, sourceInstance: null,
      signatureKeyId: null, tokenPrefix: null,
      tokenLastReceivedAt: null, tokenExpiresAt: null,
      connectedAt: new Date(), disconnectedAt: null,
      disconnectInitiator: null, lastErrorMessage: null,
      rotationPending: false, pendingRotationGraceExpiresAt: null,
    });
    const r = await svc.getStatusForUser('u1');
    expect(r.connected).toBe(false);
    expect(r.status).toBe('pending');
  });

  it('surfaces rotationPending + pendingRotationGraceExpiresAt when set (R1)', async () => {
    const graceExp = new Date(Date.now() + 4 * 60 * 1000);
    const { svc } = build({
      isActive: true, status: 'active',
      sfTenantId: '99999', sfTenantName: null, sourceInstance: null,
      signatureKeyId: 'k1', tokenPrefix: 'sfo_v1.aa',
      tokenLastReceivedAt: new Date(), tokenExpiresAt: null,
      connectedAt: new Date(), disconnectedAt: null,
      disconnectInitiator: null, lastErrorMessage: null,
      rotationPending: true, pendingRotationGraceExpiresAt: graceExp,
    });
    const r = await svc.getStatusForUser('u1');
    expect(r.connected).toBe(true);
    expect(r.rotationPending).toBe(true);
    expect(r.pendingRotationGraceExpiresAt).toEqual(graceExp);
  });

  it('selects only safe columns — never reads orchestrationToken or webhook secret', async () => {
    const { svc, prisma } = build(null);
    await svc.getStatusForUser('u1');
    const args = prisma.sfConnection.findUnique.mock.calls[0][0];
    expect(args.select).toBeDefined();
    expect(args.select.orchestrationToken).toBeUndefined();
    expect(args.select.previousOrchestrationToken).toBeUndefined();
    // Whitelist of allowed columns (security audit point)
    const allowed = new Set([
      'isActive', 'status', 'sfTenantId', 'sfTenantName', 'sourceInstance',
      'signatureKeyId', 'tokenPrefix', 'tokenLastReceivedAt', 'tokenExpiresAt',
      'connectedAt', 'disconnectedAt', 'disconnectInitiator', 'lastErrorMessage',
      'rotationPending', 'pendingRotationGraceExpiresAt',
    ]);
    for (const k of Object.keys(args.select)) {
      expect(allowed.has(k)).toBe(true);
    }
  });
});
