/**
 * YelpIntegrationsController.collectLeads — status sync tests.
 *
 * Covers the contract from the Yelp status sync fix: every status change goes
 * through LeadStatusService.writeStatus({ source: 'platform_sync', ... }).
 * platformStatus is always the raw Yelp text; Lead.status is the mapped
 * canonical value, gated by the SF_STATUS_WINS guard.
 */

jest.mock('../common/utils/encryption.util', () => ({
  EncryptionUtil: {
    decryptObject: jest.fn().mockReturnValue({ accessToken: 'fake-token' }),
  },
}));

import { YelpIntegrationsController } from './yelp-integrations.controller';

const USER_ID = 'user-1';
const ACCOUNT_ID = 'acct-1';
const BUSINESS_ID = 'biz-1';
const LEAD_ID = 'yelp_lead_42';
const LEAD_PK = 'lead-pk-42';
const THREAD_ID = 'thread-1';

function buildController(opts: {
  existingLead: any;
  sfStatusWins?: boolean;
}) {
  const prisma: any = {
    savedAccount: {
      findFirst: jest.fn().mockResolvedValue({
        id: ACCOUNT_ID,
        userId: USER_ID,
        platform: 'yelp',
        businessId: BUSINESS_ID,
        credentialsJson: 'encrypted-blob',
      }),
    },
    lead: {
      findUnique: jest.fn().mockResolvedValue(opts.existingLead),
      update: jest.fn().mockResolvedValue({}),
    },
    conversation: {
      update: jest.fn().mockResolvedValue({}),
    },
  };

  const platformFactory: any = {
    getAdapter: jest.fn().mockReturnValue({ getLead: jest.fn() }),
  };
  const platformService: any = {};

  const configService: any = {
    get: jest.fn((key: string, def?: string) => {
      if (key === 'encryption.key') return 'test-key';
      if (key === 'SF_STATUS_WINS') return opts.sfStatusWins ? 'true' : 'false';
      return def;
    }),
  };

  const leadStatusService: any = {
    writeStatus: jest.fn().mockResolvedValue({
      leadId: LEAD_PK,
      applied: true,
      status: opts.existingLead?.status ?? 'new',
      platformStatus: null,
      conflict: null,
      auditLogId: 'audit-1',
    }),
  };

  const followUpEngine: any = {
    handlePlatformSignal: jest.fn().mockResolvedValue('no_change'),
  };

  const controller = new YelpIntegrationsController(
    prisma,
    platformService,
    platformFactory,
    configService,
    leadStatusService,
    followUpEngine,
  );

  return { controller, prisma, leadStatusService, followUpEngine };
}

function leadFixture(overrides: any = {}) {
  return {
    id: LEAD_PK,
    userId: USER_ID,
    platform: 'yelp',
    externalRequestId: LEAD_ID,
    threadId: THREAD_ID,
    customerName: 'Jane Doe',
    status: 'new',
    platformStatus: null,
    sfJobId: null,
    category: 'Plumbing',
    city: 'Tampa',
    ...overrides,
  };
}

const COLLECT_BODY_BASE = {
  savedAccountId: ACCOUNT_ID,
  businessId: BUSINESS_ID,
  leadIds: [LEAD_ID],
};

const FAKE_USER = { id: USER_ID };

describe('YelpIntegrationsController.collectLeads — status sync', () => {
  describe('mapped Yelp statuses', () => {
    it('Yelp Hired → writes platformStatus=Hired AND Lead.status=booked', async () => {
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture(),
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Hired' },
      });

      const calls = leadStatusService.writeStatus.mock.calls.map((c: any[]) => c[0]);
      // First call: platformStatus write with raw Yelp text
      expect(calls).toContainEqual(
        expect.objectContaining({
          leadId: LEAD_PK,
          source: 'platform_sync',
          platformStatus: 'Hired',
        }),
      );
      // Second call: canonical LB status write
      expect(calls).toContainEqual(
        expect.objectContaining({
          leadId: LEAD_PK,
          source: 'platform_sync',
          newStatus: 'booked',
        }),
      );
    });

    it('Yelp Done → Lead.status=completed', async () => {
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture(),
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Done' },
      });

      const newStatusCalls = leadStatusService.writeStatus.mock.calls
        .map((c: any[]) => c[0])
        .filter((arg: any) => arg.newStatus !== undefined);
      expect(newStatusCalls).toHaveLength(1);
      expect(newStatusCalls[0].newStatus).toBe('completed');
    });

    it('Yelp Not hired → Lead.status=lost', async () => {
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture(),
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Not hired' },
      });

      const newStatusCalls = leadStatusService.writeStatus.mock.calls
        .map((c: any[]) => c[0])
        .filter((arg: any) => arg.newStatus !== undefined);
      expect(newStatusCalls).toHaveLength(1);
      expect(newStatusCalls[0].newStatus).toBe('lost');
    });

    it('Yelp Active → Lead.status=contacted', async () => {
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture(),
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Active' },
      });

      const newStatusCalls = leadStatusService.writeStatus.mock.calls
        .map((c: any[]) => c[0])
        .filter((arg: any) => arg.newStatus !== undefined);
      expect(newStatusCalls).toHaveLength(1);
      expect(newStatusCalls[0].newStatus).toBe('contacted');
    });

    it('Yelp Closed → Lead.status=lost (synonym for Not hired)', async () => {
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture(),
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Closed' },
      });

      const newStatusCalls = leadStatusService.writeStatus.mock.calls
        .map((c: any[]) => c[0])
        .filter((arg: any) => arg.newStatus !== undefined);
      expect(newStatusCalls[0].newStatus).toBe('lost');
    });

    it('Yelp Archived → Lead.status=archived', async () => {
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture(),
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Archived' },
      });

      const newStatusCalls = leadStatusService.writeStatus.mock.calls
        .map((c: any[]) => c[0])
        .filter((arg: any) => arg.newStatus !== undefined);
      expect(newStatusCalls[0].newStatus).toBe('archived');
    });
  });

  describe('SF protection guard', () => {
    it('skips Lead.status write when SF_STATUS_WINS=true and lead has sfJobId', async () => {
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture({ sfJobId: 'sfjob-99' }),
        sfStatusWins: true,
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Hired' },
      });

      const calls = leadStatusService.writeStatus.mock.calls.map((c: any[]) => c[0]);
      // platformStatus must still be written
      expect(calls.some((a: any) => a.platformStatus === 'Hired')).toBe(true);
      // canonical Lead.status must NOT be written
      expect(calls.some((a: any) => a.newStatus === 'booked')).toBe(false);
    });

    it('still writes Lead.status when SF_STATUS_WINS=false even if sfJobId set', async () => {
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture({ sfJobId: 'sfjob-99' }),
        sfStatusWins: false,
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Hired' },
      });

      const calls = leadStatusService.writeStatus.mock.calls.map((c: any[]) => c[0]);
      expect(calls.some((a: any) => a.newStatus === 'booked')).toBe(true);
    });
  });

  describe('unmapped Yelp values', () => {
    it('writes platformStatus only — no Lead.status write — for unknown raw status', async () => {
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture(),
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Inquired' }, // not in mapping table
      });

      const calls = leadStatusService.writeStatus.mock.calls.map((c: any[]) => c[0]);
      expect(calls.some((a: any) => a.platformStatus === 'Inquired')).toBe(true);
      expect(calls.some((a: any) => a.newStatus !== undefined)).toBe(false);
    });
  });

  describe('handlePlatformSignal', () => {
    it('fires after the write for relevant signals (Hired)', async () => {
      const { controller, followUpEngine } = buildController({
        existingLead: leadFixture(),
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Hired' },
      });

      // handlePlatformSignal is fired async (.then chain); flush microtasks.
      await new Promise((r) => setImmediate(r));

      expect(followUpEngine.handlePlatformSignal).toHaveBeenCalledWith(THREAD_ID, 'Hired');
    });
  });

  describe('no-op cases', () => {
    it('does not call writeStatus when status is unchanged', async () => {
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture({ status: 'booked', platformStatus: 'Hired' }),
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Hired' },
      });

      expect(leadStatusService.writeStatus).not.toHaveBeenCalled();
    });
  });
});
