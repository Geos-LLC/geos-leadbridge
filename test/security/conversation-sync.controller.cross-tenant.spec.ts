/**
 * Cross-tenant access tests for ConversationSyncController — Phase 1B.
 *
 * This controller was already exemplary: a private `verifyAccountOwnership`
 * helper throws HttpException(NOT_FOUND) on mismatch, and lead-scoped routes
 * do `lead.findFirst({id, userId})` then throw NOT_FOUND on null. The tests
 * below pin that behavior so a future refactor can't drop the checks.
 */

import { HttpException } from '@nestjs/common';
import { ConversationSyncController } from '../../src/conversation-sync/conversation-sync.controller';

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
  } as any;
}

function buildSyncService() {
  return {
    getConnection: jest.fn().mockResolvedValue({ status: 'ACTIVE' }),
    connect: jest.fn().mockResolvedValue({ success: true, phoneNumbers: [] }),
    disconnect: jest.fn().mockResolvedValue({ success: true }),
    refreshNumbers: jest.fn().mockResolvedValue([]),
    triggerOpenPhoneSync: jest.fn().mockResolvedValue({ success: true }),
    getSyncStatus: jest.fn().mockResolvedValue({}),
    matchLeadConversations: jest.fn().mockResolvedValue({ synced: 0, totalConversations: 0, totalLeads: 0 }),
    getLeadSmsActivity: jest.fn().mockResolvedValue([]),
    getLeadConversations: jest.fn().mockResolvedValue([]),
  } as any;
}

function makeController(ownerUserId: string) {
  const prisma = buildPrisma(ownerUserId);
  const service = buildSyncService();
  const controller = new ConversationSyncController(service, { get: jest.fn() } as any, prisma);
  return { controller, service, prisma };
}

describe('ConversationSyncController — cross-tenant access', () => {
  const OWNER = 'user-a';
  const INTRUDER = 'user-b';
  const ACCOUNT_ID = 'acct-owned-by-a';
  const LEAD_ID = 'lead-owned-by-a';

  describe('savedAccount-scoped routes throw on intrusion (404 via HttpException)', () => {
    it.each([
      ['getStatus', (c: ConversationSyncController) => c.getStatus({ id: INTRUDER }, ACCOUNT_ID)],
      ['connect', (c: ConversationSyncController) => c.connect({ id: INTRUDER }, ACCOUNT_ID, { apiKey: 'k' })],
      ['disconnect', (c: ConversationSyncController) => c.disconnect({ id: INTRUDER }, ACCOUNT_ID)],
      ['refreshNumbers', (c: ConversationSyncController) => c.refreshNumbers({ id: INTRUDER }, ACCOUNT_ID)],
      ['syncOpenPhone', (c: ConversationSyncController) => c.syncOpenPhone({ id: INTRUDER }, ACCOUNT_ID)],
      ['getSyncStatus', (c: ConversationSyncController) => c.getSyncStatus({ id: INTRUDER }, ACCOUNT_ID)],
      ['matchLeads', (c: ConversationSyncController) => c.matchLeads({ id: INTRUDER }, ACCOUNT_ID)],
    ])('%s throws and surface is 404', async (_label, invoke) => {
      const { controller } = makeController(OWNER);
      await expect(invoke(controller)).rejects.toBeInstanceOf(HttpException);
      try {
        await invoke(controller);
      } catch (err: any) {
        expect(err.getStatus()).toBe(404);
      }
    });

    it('downstream service is not invoked on intrusion', async () => {
      const { controller, service } = makeController(OWNER);
      await expect(controller.connect({ id: INTRUDER }, ACCOUNT_ID, { apiKey: 'k' })).rejects.toBeInstanceOf(HttpException);
      expect(service.connect).not.toHaveBeenCalled();
    });
  });

  describe('lead-scoped routes throw 404 on intrusion', () => {
    it.each([
      ['getLeadActivity', (c: ConversationSyncController) => c.getLeadActivity({ id: INTRUDER }, LEAD_ID)],
      ['getLeadConversations', (c: ConversationSyncController) => c.getLeadConversations({ id: INTRUDER }, LEAD_ID)],
    ])('%s throws HttpException(404)', async (_label, invoke) => {
      const { controller } = makeController(OWNER);
      try {
        await invoke(controller);
        fail('expected throw');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(404);
      }
    });
  });
});
