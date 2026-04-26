/**
 * Cross-tenant access tests for CallConnectController — Phase 1A.
 *
 * Before this PR, every guard threw ForbiddenException (403), which leaks
 * "this record exists but isn't yours" — a 404 does not. Also, cancelSession
 * verified the savedAccountId belonged to the caller but did not verify the
 * sigcoreSessionId belonged to one of the user's leads, so an attacker could
 * supply User B's sessionId paired with their own savedAccountId and cancel
 * the call.
 *
 * Both holes are now closed via TenancyService. These tests pin the behavior:
 *   - cross-tenant access throws NotFoundException (404)
 *   - cancelSession requires BOTH the saved account AND the session to belong
 *     to the caller
 */

import { NotFoundException } from '@nestjs/common';
import { CallConnectController } from '../../src/call-connect/call-connect.controller';
import { TenancyService } from '../../src/common/tenancy/tenancy.service';

function buildPrisma(ownerUserId: string) {
  return {
    savedAccount: {
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        if (where?.userId === ownerUserId) return Promise.resolve({ id: where.id });
        return Promise.resolve(null);
      }),
    },
    lead: {
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        if (where?.userId === ownerUserId) return Promise.resolve({ id: where.id });
        return Promise.resolve(null);
      }),
    },
    leadCallConnect: {
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        if (where?.lead?.userId === ownerUserId) return Promise.resolve({ id: 'lc1' });
        return Promise.resolve(null);
      }),
    },
  } as any;
}

function buildCallConnectService() {
  return {
    canUseCallConnect: jest.fn().mockReturnValue(true),
    getSettings: jest.fn().mockResolvedValue({ enabled: true }),
    saveSettings: jest.fn().mockResolvedValue({ enabled: true }),
    getSessionsForLead: jest.fn().mockResolvedValue([]),
    triggerTestCall: jest.fn().mockResolvedValue({ sessionId: 'sess-1' }),
    cancelSession: jest.fn().mockResolvedValue(undefined),
  } as any;
}

function makeController(ownerUserId: string) {
  const prisma = buildPrisma(ownerUserId);
  const service = buildCallConnectService();
  const tenancy = new TenancyService(prisma);
  const controller = new CallConnectController(service, prisma, tenancy);
  return { controller, prisma, service };
}

describe('CallConnectController — cross-tenant access', () => {
  const OWNER = 'user-a';
  const INTRUDER = 'user-b';
  const ACCOUNT_ID = 'acct-owned-by-a';
  const LEAD_ID = 'lead-owned-by-a';
  const SESSION_ID = 'sess-owned-by-a';

  describe('owner can use the endpoints', () => {
    it('getSettings returns settings', async () => {
      const { controller } = makeController(OWNER);
      const res = await controller.getSettings(ACCOUNT_ID, { user: { id: OWNER } } as any);
      expect(res.settings).toEqual({ enabled: true });
    });

    it('cancelSession dispatches when both account and session belong to caller', async () => {
      const { controller, service } = makeController(OWNER);
      const res = await controller.cancelSession(
        { sessionId: SESSION_ID, savedAccountId: ACCOUNT_ID },
        { user: { id: OWNER } } as any,
      );
      expect(res).toEqual({ cancelled: true });
      expect(service.cancelSession).toHaveBeenCalledWith(SESSION_ID, ACCOUNT_ID);
    });
  });

  describe('cross-tenant access returns 404, not 403', () => {
    const intruderReq = { user: { id: INTRUDER } } as any;

    it.each([
      ['getSettings', (c: CallConnectController) => c.getSettings(ACCOUNT_ID, intruderReq)],
      ['saveSettings', (c: CallConnectController) =>
        c.saveSettings({ savedAccountId: ACCOUNT_ID, enabled: true } as any, intruderReq)],
      ['getLeadSessions', (c: CallConnectController) => c.getLeadSessions(LEAD_ID, intruderReq)],
      ['testCall', (c: CallConnectController) =>
        c.testCall({ savedAccountId: ACCOUNT_ID, testPhone: '+1555' }, intruderReq)],
    ])('%s throws NotFoundException', async (_label, invoke) => {
      const { controller } = makeController(OWNER);
      await expect(invoke(controller)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cancelSession throws NotFoundException when caller does not own the saved account', async () => {
      const { controller } = makeController(OWNER);
      await expect(
        controller.cancelSession({ sessionId: SESSION_ID, savedAccountId: ACCOUNT_ID }, intruderReq),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cancelSession throws NotFoundException when account is owned but session belongs to another tenant', async () => {
      const { controller, service } = makeController(OWNER);
      // Owner's account but a sessionId that does not belong to any of their leads.
      const prismaAny = (controller as any).prisma;
      prismaAny.leadCallConnect.findFirst.mockResolvedValue(null);
      await expect(
        controller.cancelSession(
          { sessionId: 'foreign-session', savedAccountId: ACCOUNT_ID },
          { user: { id: OWNER } } as any,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(service.cancelSession).not.toHaveBeenCalled();
    });
  });

  describe('downstream service is not invoked on intrusion', () => {
    const intruderReq = { user: { id: INTRUDER } } as any;

    it('saveSettings does not run', async () => {
      const { controller, service } = makeController(OWNER);
      await expect(
        controller.saveSettings({ savedAccountId: ACCOUNT_ID, enabled: true } as any, intruderReq),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(service.saveSettings).not.toHaveBeenCalled();
    });

    it('triggerTestCall does not run', async () => {
      const { controller, service } = makeController(OWNER);
      await expect(
        controller.testCall({ savedAccountId: ACCOUNT_ID, testPhone: '+1555' }, intruderReq),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(service.triggerTestCall).not.toHaveBeenCalled();
    });

    it('getSessionsForLead does not run', async () => {
      const { controller, service } = makeController(OWNER);
      await expect(controller.getLeadSessions(LEAD_ID, intruderReq)).rejects.toBeInstanceOf(NotFoundException);
      expect(service.getSessionsForLead).not.toHaveBeenCalled();
    });
  });
});
