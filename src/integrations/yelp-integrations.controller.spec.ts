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
  /** When set, the API getLead either returns this fake leadData (success) or
   *  throws to drive the fallback-create branch. */
  apiGetLead?: { kind: 'success'; leadData: any } | { kind: 'throw'; error: any };
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
      // create returns the fake new-lead row so applyScrapedStatusToCreatedLead
      // can pass its id to writeStatus.
      create: jest.fn().mockImplementation(async ({ data }: any) => ({
        id: LEAD_PK,
        ...data,
      })),
    },
    conversation: {
      update: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({ id: THREAD_ID }),
    },
  };

  const adapterGetLead = opts.apiGetLead?.kind === 'throw'
    ? jest.fn().mockRejectedValue(opts.apiGetLead.error)
    : opts.apiGetLead?.kind === 'success'
    ? jest.fn().mockResolvedValue(opts.apiGetLead.leadData)
    : jest.fn();

  const platformFactory: any = {
    getAdapter: jest.fn().mockReturnValue({ getLead: adapterGetLead }),
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

    it('Yelp Archived → newStatus=lost + lostReason=hired_someone (UI shows "No hire")', async () => {
      // Yelp's "Archived" inbox status means the lead didn't convert.
      // Per spec it lands in LB as `lost` (not `archived` — that bucket is
      // reserved for explicit LB-side archives) with lostReason=hired_someone
      // so the frontend pill renders "No hire" via the lost→no_hire group map.
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture(),
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Archived' },
      });

      expect(leadStatusService.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          newStatus: 'lost',
          platformStatus: 'Archived',
          lostReason: 'hired_someone',
        }),
      );
    });

    it('Yelp Not hired carries lostReason=hired_someone', async () => {
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture(),
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Not hired' },
      });

      expect(leadStatusService.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          newStatus: 'lost',
          platformStatus: 'Not hired',
          lostReason: 'hired_someone',
        }),
      );
    });

    it('Yelp Closed carries lostReason=hired_someone', async () => {
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture(),
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Closed' },
      });

      expect(leadStatusService.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          newStatus: 'lost',
          platformStatus: 'Closed',
          lostReason: 'hired_someone',
        }),
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

  // The user task explicitly requires that NEW lead creation paths (both the
  // API-success and the API-failure fallback) route raw scraped statuses
  // through writeStatus rather than writing them directly to Lead.status. The
  // previous fallback code wrote `leadStatuses[id].toLowerCase()` straight
  // into Lead.status — that bypassed the canonical pipeline, the audit log,
  // and SF protection. These tests pin the new behavior: Lead.status gets
  // canonical 'new' on create, then writeStatus carries the raw → canonical
  // transition.
  describe('new lead creation — fallback path (Yelp API failed)', () => {
    function fallbackController(rawScraped?: string) {
      return buildController({
        existingLead: null,
        apiGetLead: { kind: 'throw', error: new Error('401 Unauthorized') },
        ...(rawScraped !== undefined ? {} : {}),
      });
    }

    it('Active → creates lead with status=new, then writeStatus(newStatus=contacted, platformStatus=Active)', async () => {
      const { controller, prisma, leadStatusService } = fallbackController();

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Active' },
      });

      // Lead created with canonical default 'new', not 'active'.
      expect(prisma.lead.create).toHaveBeenCalledTimes(1);
      const createArgs = prisma.lead.create.mock.calls[0][0];
      expect(createArgs.data.status).toBe('new');

      // Then writeStatus carries the raw → canonical transition.
      expect(leadStatusService.writeStatus).toHaveBeenCalledTimes(1);
      const writeArgs = leadStatusService.writeStatus.mock.calls[0][0];
      expect(writeArgs).toEqual(
        expect.objectContaining({
          source: 'platform_sync',
          newStatus: 'contacted',
          platformStatus: 'Active',
          actorType: 'extension',
        }),
      );
      expect(typeof writeArgs.sourceEventId).toBe('string');
      expect(writeArgs.sourceEventId).toContain(LEAD_ID);
    });

    it('Done → newStatus=completed, platformStatus=Done', async () => {
      const { controller, leadStatusService } = fallbackController();
      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Done' },
      });
      expect(leadStatusService.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({ newStatus: 'completed', platformStatus: 'Done' }),
      );
    });

    it('Not hired → newStatus=lost, platformStatus="Not hired"', async () => {
      const { controller, leadStatusService } = fallbackController();
      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Not hired' },
      });
      expect(leadStatusService.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({ newStatus: 'lost', platformStatus: 'Not hired' }),
      );
    });

    it('unknown raw status (e.g. "Inquired") → writeStatus carries platformStatus only, newStatus undefined', async () => {
      const { controller, prisma, leadStatusService } = fallbackController();
      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Inquired' },
      });

      // Lead.status is the canonical default 'new', NOT 'inquired'.
      expect(prisma.lead.create.mock.calls[0][0].data.status).toBe('new');

      // platformStatus carries the raw value but newStatus is undefined so
      // applyPlatformSync only writes platformStatus.
      const writeArgs = leadStatusService.writeStatus.mock.calls[0][0];
      expect(writeArgs.platformStatus).toBe('Inquired');
      expect(writeArgs.newStatus).toBeUndefined();
    });

    it('no scraped status at all → no writeStatus call (lead has only canonical default)', async () => {
      const { controller, prisma, leadStatusService } = fallbackController();
      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        // no leadStatuses field
      });
      expect(prisma.lead.create.mock.calls[0][0].data.status).toBe('new');
      expect(leadStatusService.writeStatus).not.toHaveBeenCalled();
    });

    it('SF-linked lead with SF_STATUS_WINS=true: controller still calls writeStatus; service decides whether to apply', async () => {
      // The SF protection lives inside applyPlatformSync — the controller is
      // intentionally dumb. This test pins that the controller forwards both
      // fields rather than second-guessing the service.
      const { controller, leadStatusService } = buildController({
        existingLead: null,
        apiGetLead: { kind: 'throw', error: new Error('503 Service Unavailable') },
        sfStatusWins: true,
        writeStatusResult: {
          leadId: LEAD_PK,
          applied: true,
          status: 'new',
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
          source: 'platform_sync',
          newStatus: 'booked',
          platformStatus: 'Hired',
        }),
      );
    });
  });

  // Cross-account guard mirrors the THUMBTACK_OTHER_ACCOUNT pattern shipped in
  // 8ba4735 / e1a10f4. Same user, but the lead's existing row lives under a
  // different Yelp SavedAccount — silently re-attributing under the operator-
  // selected account would corrupt downstream filters / analytics.
  describe('cross-account guard (same user, different businessId)', () => {
    it('skips with otherAccount when existing lead belongs to a different Yelp business under same user', async () => {
      const OTHER_BUSINESS_ID = 'biz-jacksonville';
      const { controller, prisma, leadStatusService } = buildController({
        existingLead: leadFixture({ businessId: OTHER_BUSINESS_ID }),
      });
      // Override the savedAccount findFirst sequence: first call resolves the
      // current SavedAccount (Tampa, biz-1); second call resolves the owning
      // SavedAccount for the message ("Spotless Homes Jacksonville").
      prisma.savedAccount.findFirst
        .mockResolvedValueOnce({
          id: ACCOUNT_ID,
          userId: USER_ID,
          platform: 'yelp',
          businessId: BUSINESS_ID, // 'biz-1' = Tampa
          credentialsJson: 'encrypted-blob',
        })
        .mockResolvedValueOnce({ businessName: 'Spotless Homes Jacksonville' });

      const result: any = await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Hired' },
      });

      // Existing lead is NOT mutated — neither prisma.lead.update nor
      // writeStatus fire when the cross-account guard catches it.
      expect(prisma.lead.update).not.toHaveBeenCalled();
      expect(leadStatusService.writeStatus).not.toHaveBeenCalled();

      // Structured skip surfaces the owning SavedAccount.
      expect(result.skipped).toBe(1);
      expect(result.skippedDetails.otherAccount).toEqual([
        {
          id: LEAD_ID,
          businessId: OTHER_BUSINESS_ID,
          businessName: 'Spotless Homes Jacksonville',
        },
      ]);
      expect(result.skippedDetails.wrongScope).toEqual([]);
    });

    it('does not engage the guard when existing.businessId matches the operator-selected account', async () => {
      const { controller, leadStatusService } = buildController({
        existingLead: leadFixture({ businessId: BUSINESS_ID }),
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Hired' },
      });

      // Same-account update path runs as normal — writeStatus fires.
      expect(leadStatusService.writeStatus).toHaveBeenCalled();
    });
  });

  describe('wrong-scope detection on Yelp API 403', () => {
    it('skips with wrongScope and does NOT fall through to fallback-create when API returns 403', async () => {
      const yelpForbidden: any = new Error('Request failed with status code 403');
      yelpForbidden.response = {
        status: 403,
        data: { error: { code: 'NOT_AUTHORIZED', description: 'Lead not in your scope' } },
      };
      const { controller, prisma, leadStatusService } = buildController({
        existingLead: null,
        apiGetLead: { kind: 'throw', error: yelpForbidden },
      });

      const result: any = await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Hired' },
      });

      // No fallback create — we don't own this lead.
      expect(prisma.lead.create).not.toHaveBeenCalled();
      expect(leadStatusService.writeStatus).not.toHaveBeenCalled();

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.skippedDetails.wrongScope).toEqual([
        {
          id: LEAD_ID,
          message: 'This lead belongs to a different connected Yelp account.',
        },
      ]);
      expect(result.skippedDetails.otherAccount).toEqual([]);
    });

    it('still falls through to fallback-create on 401 (token expired, not wrong scope)', async () => {
      const tokenExpired: any = new Error('Request failed with status code 401');
      tokenExpired.response = { status: 401 };
      const { controller, prisma, leadStatusService } = buildController({
        existingLead: null,
        apiGetLead: { kind: 'throw', error: tokenExpired },
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Hired' },
      });

      // 401 = token problem, not scope problem. Existing fallback-create
      // path still runs so the operator at least has a row to reconnect from.
      expect(prisma.lead.create).toHaveBeenCalledTimes(1);
      expect(leadStatusService.writeStatus).toHaveBeenCalled();
    });
  });

  describe('new lead creation — API-success path', () => {
    it('Active → lead created with canonical "new", writeStatus carries raw → canonical', async () => {
      const { controller, prisma, leadStatusService } = buildController({
        existingLead: null,
        apiGetLead: {
          kind: 'success',
          leadData: {
            customerName: 'Bob',
            customerPhone: '+15555550101',
            customerEmail: 'bob@example.com',
            message: 'Need plumbing',
            city: 'Tampa',
            state: 'FL',
            postcode: '33601',
            category: 'Plumbing',
            // adapter returned 'active' — this used to leak straight into
            // Lead.status. Now it must NOT.
            status: 'active',
            createdAt: new Date('2026-04-30T00:00:00Z'),
            raw: { id: LEAD_ID },
          },
        },
      });

      await controller.collectLeads(FAKE_USER, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [LEAD_ID]: 'Active' },
      });

      // Lead.status is canonical 'new', not the raw 'active' from the adapter.
      expect(prisma.lead.create.mock.calls[0][0].data.status).toBe('new');

      // writeStatus then runs the platform_sync transition.
      expect(leadStatusService.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'platform_sync',
          newStatus: 'contacted',
          platformStatus: 'Active',
        }),
      );
    });
  });
});
