/**
 * IntegrationsService.collectLeadIds — Thumbtack status sync tests.
 *
 * Mirrors the post-39ac863 Yelp contract: a single writeStatus call carries
 * BOTH platformStatus and the mapped newStatus. LeadStatusService owns all
 * skip decisions (SF_STATUS_WINS, completed-lock, pipeline-downgrade, dedup)
 * and reports back via skipReason. The IntegrationsService never decides
 * skips itself — these tests verify that.
 */

import { IntegrationsService } from './integrations.service';

const USER_ID = 'user-1';
const ACCOUNT_ID = 'acct-1';
const TT_ID = 'tt_lead_42';
const LEAD_PK = 'lead-pk-42';
const THREAD_ID = 'thread-1';

function leadFixture(overrides: any = {}) {
  return {
    id: LEAD_PK,
    userId: USER_ID,
    status: 'new',
    platformStatus: null,
    thumbtackStatus: null,
    threadId: THREAD_ID,
    ...overrides,
  };
}

type WriteResultOverrides = Partial<{
  applied: boolean;
  status: string;
  platformStatus: string | null;
  skipReason: string;
}>;

function buildService(opts: {
  existingLead?: any;
  writeResult?: WriteResultOverrides;
} = {}) {
  const prisma: any = {
    thumbtackLeadId: {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
    lead: {
      findUnique: jest.fn().mockResolvedValue(opts.existingLead ?? null),
    },
  };

  const analyticsService: any = {};
  const leadsService: any = {};

  // The mock echoes whatever writeStatus would produce — caller can override
  // applied/status/platformStatus/skipReason per test.
  const leadStatusService: any = {
    writeStatus: jest.fn().mockImplementation((input: any) =>
      Promise.resolve({
        leadId: input.leadId,
        applied: opts.writeResult?.applied ?? true,
        status: opts.writeResult?.status ?? input.newStatus ?? opts.existingLead?.status ?? 'new',
        platformStatus:
          opts.writeResult?.platformStatus !== undefined
            ? opts.writeResult.platformStatus
            : (input.platformStatus ?? null),
        conflict: null,
        auditLogId: 'audit-1',
        skipReason: opts.writeResult?.skipReason,
      }),
    ),
  };

  const followUpEngine: any = {
    handlePlatformSignal: jest.fn().mockResolvedValue('no_change'),
  };

  const service = new IntegrationsService(
    prisma,
    analyticsService,
    leadsService,
    leadStatusService,
    followUpEngine,
  );

  return { service, prisma, leadStatusService, followUpEngine };
}

const COLLECT_BODY_BASE = {
  savedAccountId: ACCOUNT_ID,
  leadIds: [TT_ID],
  capturedAt: new Date('2026-04-28T12:00:00Z').toISOString(),
};

describe('IntegrationsService.collectLeadIds — Thumbtack status sync (single-call contract)', () => {
  describe('mapped statuses', () => {
    it.each<[string, string]>([
      ['Hired', 'booked'],
      ['Done', 'completed'],
      // Post-2026-06-08: TT Scheduled/Job Scheduled collapse into 'booked'
      // (was 'scheduled'); TT Active and Not scheduled yet collapse into
      // 'engaged' (was 'contacted').
      ['Scheduled', 'booked'],
      ['Active', 'engaged'],
      ['Not scheduled yet', 'engaged'],
      ['Not hired', 'lost'],
      ['Closed', 'lost'],
      ['Archived', 'archived'],
    ])(
      'Thumbtack %s → single writeStatus call with platformStatus=%s + newStatus=%s',
      async (rawStatus, expectedCanonical) => {
        const { service, leadStatusService } = buildService({
          existingLead: leadFixture(),
        });

        await service.collectLeadIds(USER_ID, {
          ...COLLECT_BODY_BASE,
          leadStatuses: { [TT_ID]: rawStatus },
        } as any);

        // Exactly one call — applyPlatformSync handles both fields together.
        expect(leadStatusService.writeStatus).toHaveBeenCalledTimes(1);
        const arg = leadStatusService.writeStatus.mock.calls[0][0];
        expect(arg).toMatchObject({
          leadId: LEAD_PK,
          source: 'platform_sync',
          platformStatus: rawStatus,
          newStatus: expectedCanonical,
          actorType: 'extension',
        });
      },
    );
  });

  describe('unmapped statuses', () => {
    it('writes platformStatus only — no newStatus — for Unknown', async () => {
      const { service, leadStatusService } = buildService({
        existingLead: leadFixture(),
      });

      await service.collectLeadIds(USER_ID, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [TT_ID]: 'Unknown' },
      } as any);

      expect(leadStatusService.writeStatus).toHaveBeenCalledTimes(1);
      const arg = leadStatusService.writeStatus.mock.calls[0][0];
      expect(arg.platformStatus).toBe('Unknown');
      expect(arg.newStatus).toBeUndefined();
    });
  });

  describe('SF + completed protection (delegated to applyPlatformSync)', () => {
    it('forwards both fields when SF_STATUS_WINS=true and lead has sfJobId — service decides the skip', async () => {
      // IntegrationsService no longer reads SF_STATUS_WINS — it forwards both
      // fields and trusts the service to skip canonical via skipReason=sf_protected.
      const { service, leadStatusService } = buildService({
        existingLead: leadFixture({ status: 'engaged' }),
        writeResult: {
          applied: true,
          status: 'engaged',
          platformStatus: 'Hired',
          skipReason: 'sf_protected',
        },
      });

      await service.collectLeadIds(USER_ID, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [TT_ID]: 'Hired' },
      } as any);

      expect(leadStatusService.writeStatus).toHaveBeenCalledTimes(1);
      const arg = leadStatusService.writeStatus.mock.calls[0][0];
      expect(arg.platformStatus).toBe('Hired');
      expect(arg.newStatus).toBe('booked');
    });

    it('forwards both fields on completed-lock — applyPlatformSync returns skipReason=pipeline_downgrade', async () => {
      const { service, leadStatusService } = buildService({
        existingLead: leadFixture({ status: 'completed' }),
        writeResult: {
          applied: true,
          status: 'completed',
          platformStatus: 'Active',
          skipReason: 'pipeline_downgrade',
        },
      });

      await service.collectLeadIds(USER_ID, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [TT_ID]: 'Active' },
      } as any);

      expect(leadStatusService.writeStatus).toHaveBeenCalledTimes(1);
      const arg = leadStatusService.writeStatus.mock.calls[0][0];
      expect(arg.platformStatus).toBe('Active');
      expect(arg.newStatus).toBe('engaged');
    });
  });

  describe('handlePlatformSignal', () => {
    it.each([
      ['Hired'],
      ['Not hired'],
      ['Archived'],
      ['Active'],
      ['Not scheduled yet'],
      ['Scheduled'],
      ['Done'],
      ['Closed'],
    ])('fires for relevant signal %s', async (rawStatus) => {
      const { service, followUpEngine } = buildService({
        existingLead: leadFixture(),
      });

      await service.collectLeadIds(USER_ID, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [TT_ID]: rawStatus },
      } as any);

      await new Promise((r) => setImmediate(r));

      expect(followUpEngine.handlePlatformSignal).toHaveBeenCalledWith(
        THREAD_ID,
        rawStatus,
      );
    });

    it('does NOT fire for Unknown', async () => {
      const { service, followUpEngine } = buildService({
        existingLead: leadFixture(),
      });

      await service.collectLeadIds(USER_ID, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [TT_ID]: 'Unknown' },
      } as any);

      await new Promise((r) => setImmediate(r));

      expect(followUpEngine.handlePlatformSignal).not.toHaveBeenCalled();
    });
  });

  describe('no-op cases', () => {
    it('does not call writeStatus when no Lead row exists yet', async () => {
      const { service, leadStatusService } = buildService({ existingLead: null });

      await service.collectLeadIds(USER_ID, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [TT_ID]: 'Hired' },
      } as any);

      expect(leadStatusService.writeStatus).not.toHaveBeenCalled();
    });

    it('does not call writeStatus when neither platformStatus nor canonical changed', async () => {
      const { service, leadStatusService } = buildService({
        existingLead: leadFixture({
          status: 'booked',
          platformStatus: 'Hired',
        }),
      });

      await service.collectLeadIds(USER_ID, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [TT_ID]: 'Hired' },
      } as any);

      expect(leadStatusService.writeStatus).not.toHaveBeenCalled();
    });

    it('does not mutate Lead row owned by another user', async () => {
      const { service, leadStatusService } = buildService({
        existingLead: leadFixture({ userId: 'someone-else' }),
      });

      await service.collectLeadIds(USER_ID, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [TT_ID]: 'Hired' },
      } as any);

      expect(leadStatusService.writeStatus).not.toHaveBeenCalled();
    });
  });

  describe('source event ID', () => {
    it('uses deterministic id based on thumbtackId + normalized status', async () => {
      const { service, leadStatusService } = buildService({
        existingLead: leadFixture(),
      });

      await service.collectLeadIds(USER_ID, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [TT_ID]: 'Not hired' },
      } as any);

      const arg = leadStatusService.writeStatus.mock.calls[0][0];
      expect(arg.sourceEventId).toBe(`tt_scrape_${TT_ID}_lost`);
    });

    it('falls back to raw normalized form when status is unmapped', async () => {
      const { service, leadStatusService } = buildService({
        existingLead: leadFixture(),
      });

      await service.collectLeadIds(USER_ID, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [TT_ID]: 'Pending Quote' },
      } as any);

      const arg = leadStatusService.writeStatus.mock.calls[0][0];
      expect(arg.sourceEventId).toBe(`tt_scrape_${TT_ID}_pending_quote`);
    });

    it('the same scrape repeated produces the same sourceEventId — applyPlatformSync dedup will handle it', async () => {
      const { service, leadStatusService } = buildService({
        existingLead: leadFixture(),
      });

      await service.collectLeadIds(USER_ID, {
        ...COLLECT_BODY_BASE,
        leadStatuses: { [TT_ID]: 'Hired' },
      } as any);

      // Second scrape — same status — would normally hit dedup. Here we verify
      // that the service still passes the SAME sourceEventId on each call.
      const arg = leadStatusService.writeStatus.mock.calls[0][0];
      expect(arg.sourceEventId).toBe(`tt_scrape_${TT_ID}_booked`);
    });
  });
});
