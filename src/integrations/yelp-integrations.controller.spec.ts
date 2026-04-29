/**
 * YelpIntegrationsController.collectLeads — status sync tests.
 *
 * The controller hands the raw Yelp text + mapped LB canonical status to
 * LeadStatusService.writeStatus in a single call. Authoritative gating
 * (SF_STATUS_WINS, downgrade, dedup, completed-lock) lives inside the
 * service; the controller only forwards. These tests verify the call shape,
 * the no-change short-circuit, and that downstream re-engagement
 * (handlePlatformSignal) still fires.
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
  writeStatusResult?: any;
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

  const defaultResult = {
    leadId: LEAD_PK,
    applied: true,
    status: opts.existingLead?.status ?? 'new',
    platformStatus: null,
    conflict: null,
    auditLogId: 'audit-1',
  };

  const leadStatusService: any = {
    writeStatus: jest.fn().mockResolvedValue(opts.writeStatusResult ?? defaultResult),
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
    it('Yelp Hired → single writeStatus call with platformStatus=Hired AND newStatus=booked', async () => {
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture(),
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Hired' },
      });

      expect(leadStatusService.writeStatus).toHaveBeenCalledTimes(1);
      expect(leadStatusService.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          leadId: LEAD_PK,
          source: 'platform_sync',
          platformStatus: 'Hired',
          newStatus: 'booked',
        }),
      );
    });

    it('Yelp Done → newStatus=completed', async () => {
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture(),
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Done' },
      });

      expect(leadStatusService.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({ newStatus: 'completed', platformStatus: 'Done' }),
      );
    });

    it('Yelp Not hired → newStatus=lost', async () => {
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture(),
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Not hired' },
      });

      expect(leadStatusService.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({ newStatus: 'lost', platformStatus: 'Not hired' }),
      );
    });

    it('Yelp Active → newStatus=contacted', async () => {
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture(),
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Active' },
      });

      expect(leadStatusService.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({ newStatus: 'contacted', platformStatus: 'Active' }),
      );
    });

    it('Yelp Closed → newStatus=lost (synonym for Not hired)', async () => {
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture(),
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Closed' },
      });

      expect(leadStatusService.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({ newStatus: 'lost', platformStatus: 'Closed' }),
      );
    });

    it('Yelp Archived → newStatus=archived', async () => {
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture(),
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Archived' },
      });

      expect(leadStatusService.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({ newStatus: 'archived', platformStatus: 'Archived' }),
      );
    });
  });

  describe('SF protection — controller forwards both fields, service decides', () => {
    it('controller passes both fields even when sfJobId set + SF_STATUS_WINS=true', async () => {
      // The controller no longer second-guesses the service; it always
      // forwards both platformStatus and newStatus. The service is the one
      // that returns skipReason='sf_protected' and skips the canonical write.
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture({ sfJobId: 'sfjob-99' }),
        sfStatusWins: true,
        writeStatusResult: {
          leadId: LEAD_PK,
          applied: true,
          status: 'new', // canonical NOT updated
          platformStatus: 'Hired',
          conflict: null,
          auditLogId: 'audit-1',
          skipReason: 'sf_protected',
        },
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Hired' },
      });

      expect(leadStatusService.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          platformStatus: 'Hired',
          newStatus: 'booked',
        }),
      );
    });
  });

  describe('unmapped Yelp values', () => {
    it('writes platformStatus only — newStatus is undefined for unknown raw status', async () => {
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture(),
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Inquired' }, // not in mapping table
      });

      const arg = leadStatusService.writeStatus.mock.calls[0][0];
      expect(arg.platformStatus).toBe('Inquired');
      expect(arg.newStatus).toBeUndefined();
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
