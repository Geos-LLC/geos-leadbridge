/**
 * ServiceFlowInboundController — subscribe endpoint regression coverage.
 *
 * Locks the defensive sf_connection upsert added 2026-06-03 after the
 * Spotless reconnect incident: SF UI reconnect created webhook
 * subscriptions but left sf_connections empty, so the sf_managed guard
 * couldn't fire and manual UI status writes were not blocked.
 *
 * The endpoint must now ALSO ensure an sf_connection row exists for
 * the user when called, in three modes:
 *
 *   (A) Reconnect — existing row of any status: reactivate, link new sub.
 *   (B) Cold register with sfTenantId in body: create minimal row.
 *   (C) Cold register without sfTenantId: skip + log warning.
 */
import { ServiceFlowInboundController } from './service-flow-inbound.controller';

function buildController(initial: {
  existingConnection?: any | null;
  existingSubscription?: any | null;
} = {}) {
  const state: any = {
    sfConnection: initial.existingConnection ?? null,
    subscription: initial.existingSubscription ?? null,
    subUpserts: [] as any[],
    sfConnCreates: [] as any[],
    sfConnUpdates: [] as any[],
  };
  const prisma: any = {
    crmWebhookSubscription: {
      upsert: jest.fn(async (args: any) => {
        state.subUpserts.push(args);
        const cur = state.subscription;
        const data = cur ? { ...cur, ...args.update } : { id: 'sub-new-1', ...args.create };
        state.subscription = data;
        return data;
      }),
    },
    sfConnection: {
      findUnique: jest.fn(async () => state.sfConnection),
      create: jest.fn(async ({ data }: any) => {
        state.sfConnCreates.push(data);
        state.sfConnection = { id: 'conn-new-1', ...data };
        return state.sfConnection;
      }),
      update: jest.fn(async ({ data }: any) => {
        state.sfConnUpdates.push(data);
        state.sfConnection = { ...(state.sfConnection || {}), ...data };
        return state.sfConnection;
      }),
    },
  };
  const sfInbound: any = {}; // not used by subscribe
  const ctrl = new ServiceFlowInboundController(prisma, sfInbound);
  return { ctrl, prisma, state };
}

describe('ServiceFlowInboundController.subscribe — sf_connection defensive upsert', () => {
  const USER_ID = 'user-1';
  const SF_TENANT = 'sf-tenant-99';

  describe('(A) Existing sf_connection (reconnect)', () => {
    it('reactivates a disconnected row + links new subscription id', async () => {
      const existingConn = {
        id: 'conn-existing',
        userId: USER_ID,
        sfTenantId: SF_TENANT,
        baseUrl: 'https://sf.example/api',
        status: 'disconnected',
        isActive: false,
        inboundSubscriptionId: 'sub-old',
        disconnectInitiator: 'lb_user',
        disconnectedAt: new Date(),
      };
      const { ctrl, state } = buildController({ existingConnection: existingConn });

      await ctrl.subscribe({ id: USER_ID } as any, { sourceInstance: 'sf-prod' });

      expect(state.subUpserts.length).toBe(1);
      expect(state.sfConnUpdates.length).toBe(1);
      const update = state.sfConnUpdates[0];
      expect(update.status).toBe('active');
      expect(update.isActive).toBe(true);
      expect(update.inboundSubscriptionId).toBe('sub-new-1');
      expect(update.disconnectInitiator).toBeNull();
      expect(update.disconnectedAt).toBeNull();
      // No create — reactivation is the right path.
      expect(state.sfConnCreates.length).toBe(0);
    });

    it('preserves existing sfTenantId + baseUrl when body omits them', async () => {
      const { ctrl, state } = buildController({
        existingConnection: {
          userId: USER_ID,
          sfTenantId: SF_TENANT,
          baseUrl: 'https://sf.example/api',
          status: 'disconnected',
          isActive: false,
        },
      });
      await ctrl.subscribe({ id: USER_ID } as any, {});
      const update = state.sfConnUpdates[0];
      expect(update.sfTenantId).toBeUndefined(); // not in update payload
      expect(update.baseUrl).toBeUndefined();
    });

    it('overwrites sfTenantId when body provides a DIFFERENT one (operator changed tenants)', async () => {
      const { ctrl, state } = buildController({
        existingConnection: {
          userId: USER_ID,
          sfTenantId: 'old-tenant',
          baseUrl: 'https://sf.example/api',
          status: 'disconnected',
          isActive: false,
        },
      });
      await ctrl.subscribe({ id: USER_ID } as any, { sfTenantId: 'new-tenant' });
      const update = state.sfConnUpdates[0];
      expect(update.sfTenantId).toBe('new-tenant');
    });

    it('reactivates an already-active row idempotently (no flip-flop)', async () => {
      const { ctrl, state } = buildController({
        existingConnection: {
          userId: USER_ID,
          sfTenantId: SF_TENANT,
          baseUrl: 'https://sf.example/api',
          status: 'active',
          isActive: true,
        },
      });
      await ctrl.subscribe({ id: USER_ID } as any, { sourceInstance: 'sf-prod' });
      // Update still runs — link the (new) sub id — but status/isActive stay 'active'/true.
      expect(state.sfConnUpdates.length).toBe(1);
      const update = state.sfConnUpdates[0];
      expect(update.status).toBe('active');
      expect(update.isActive).toBe(true);
      expect(update.inboundSubscriptionId).toBe('sub-new-1');
    });
  });

  describe('(B) No existing row, sfTenantId provided', () => {
    it('creates a minimal sf_connection row with status=active', async () => {
      const { ctrl, state } = buildController({ existingConnection: null });

      await ctrl.subscribe(
        { id: USER_ID } as any,
        { sourceInstance: 'sf-prod', sfTenantId: SF_TENANT, baseUrl: 'https://sf.example/api' },
      );

      expect(state.sfConnCreates.length).toBe(1);
      const created = state.sfConnCreates[0];
      expect(created.userId).toBe(USER_ID);
      expect(created.sfTenantId).toBe(SF_TENANT);
      expect(created.baseUrl).toBe('https://sf.example/api');
      expect(created.status).toBe('active');
      expect(created.isActive).toBe(true);
      expect(created.inboundSubscriptionId).toBe('sub-new-1');
      // Sentinel: subscription-only mode → no orchestration credentials.
      expect(created.orchestrationToken).toBe('');
      expect(created.tokenLastRotationSource).toBe('subscribe_endpoint');
      expect(state.sfConnUpdates.length).toBe(0);
    });

    it('tolerates missing baseUrl (stores empty)', async () => {
      const { ctrl, state } = buildController({ existingConnection: null });
      await ctrl.subscribe({ id: USER_ID } as any, { sfTenantId: SF_TENANT });
      expect(state.sfConnCreates[0].baseUrl).toBe('');
    });
  });

  describe('(C) No existing row, no sfTenantId — skip and warn', () => {
    it('does NOT create sf_connection when sfTenantId is absent', async () => {
      const { ctrl, state } = buildController({ existingConnection: null });

      const result = await ctrl.subscribe(
        { id: USER_ID } as any,
        { sourceInstance: 'sf-prod' }, // no sfTenantId
      );

      expect(result.success).toBe(true);
      expect(state.sfConnCreates.length).toBe(0);
      expect(state.sfConnUpdates.length).toBe(0);
      // Subscription still got created — that part of the legacy contract is unchanged.
      expect(state.subUpserts.length).toBe(1);
    });
  });

  describe('subscription creation contract (unchanged behavior)', () => {
    it('still returns secret + subscription id + events on success', async () => {
      const { ctrl } = buildController({ existingConnection: null });
      const r = await ctrl.subscribe(
        { id: USER_ID } as any,
        { sourceInstance: 'sf-prod', sfTenantId: SF_TENANT },
      );
      expect(r.success).toBe(true);
      expect(r.subscription.id).toBe('sub-new-1');
      expect(typeof r.subscription.secret).toBe('string');
      expect(r.subscription.secret.length).toBeGreaterThan(0);
    });
  });
});
