/**
 * Pin: when Yelp's send-message API returns 403 "archived this project"
 * and the adapter normalizes that into an error message containing
 * "archived", LeadsService.sendMessage:
 *   1. fires LeadStatusService.writeStatus({ source:'platform_sync',
 *      newStatus:'lost', lostReason:'hired_someone', platformStatus:'Archived' })
 *      with a deterministic sourceEventId
 *   2. re-throws BadRequestException so the UI still shows failure
 *
 * Catches the stale-status regression that left e.g. Allison C. at
 * canonical `engaged` for ~4 weeks while she was archived on Yelp: the
 * Chrome extension hadn't scraped her account, and LB had no other
 * archive signal until someone tried to send.
 */
import { BadRequestException } from '@nestjs/common';
import { LeadsService } from './leads.service';

const USER_ID = 'user-1';
const LEAD_PK = 'lead-pk-allison';
const YELP_LEAD_ID = 'Rc86xDaP1p4Lt6ZD8GS2Zw';

function buildService(opts: { platform: 'yelp' | 'thumbtack' }) {
  const lead = {
    id: LEAD_PK,
    userId: USER_ID,
    platform: opts.platform,
    externalRequestId: YELP_LEAD_ID,
    customerName: 'Allison C.',
    threadId: null,
    businessId: 'biz-1',
    status: 'engaged',
    platformStatus: null,
  };

  const prisma: any = {
    lead: {
      // sendMessage uses findFirst (not findUnique) so it can scope by userId.
      findFirst: jest.fn().mockResolvedValue(lead),
    },
  };

  const platformService: any = {
    getCredentials: jest.fn().mockResolvedValue({ accessToken: 'tok' }),
    getAccountCredentialsByBusinessId: jest
      .fn()
      .mockResolvedValue({ accessToken: 'tok' }),
  };

  // Trial gate is checked before the adapter call; allow it.
  const trialService: any = {
    canProcessLead: jest.fn().mockResolvedValue({ allowed: true }),
  };

  // Adapter throws the exact normalized message yelp.adapter.ts produces
  // when Yelp returns 403 with `description="This customer has archived this project."`.
  const archivedError = new Error(
    'Yelp lead archived by customer — This customer has archived this project.',
  );

  const platformFactory: any = {
    getAdapter: jest.fn().mockReturnValue({
      sendMessage: jest.fn().mockRejectedValue(archivedError),
    }),
  };

  const leadStatusService: any = {
    writeStatus: jest.fn().mockResolvedValue({
      leadId: LEAD_PK,
      applied: true,
      status: 'lost',
      platformStatus: 'Archived',
      conflict: null,
      auditLogId: 'audit-1',
    }),
  };

  // Stubs for things the error path never reaches.
  const noop = () => {};
  const stubsAny: any = {};
  const svc = new LeadsService(
    prisma,
    platformService,
    platformFactory,
    { get: noop } as any, // configService
    stubsAny, // templatesService
    stubsAny, // analyticsService
    stubsAny, // conversationContext
    null, // followUpEngine (optional)
    null, // crmWebhookService (optional)
    trialService,
    stubsAny, // leadCache
    stubsAny, // cache
    leadStatusService,
  );

  return { svc, prisma, platformFactory, leadStatusService };
}

describe('LeadsService.sendMessage — Yelp archived-on-send', () => {
  it('Yelp 403 archived → writeStatus(lost, hired_someone, Archived) + BadRequestException', async () => {
    const { svc, leadStatusService } = buildService({ platform: 'yelp' });

    await expect(
      svc.sendMessage(USER_ID, LEAD_PK, 'Hi Allison, are you still looking?'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(leadStatusService.writeStatus).toHaveBeenCalledTimes(1);
    expect(leadStatusService.writeStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        leadId: LEAD_PK,
        source: 'platform_sync',
        newStatus: 'lost',
        platformStatus: 'Archived',
        lostReason: 'hired_someone',
        actorType: 'system',
        actorName: 'yelp-send-403-archived',
        reason: 'yelp_send_403_archived',
      }),
    );
    // Deterministic event id keeps retries idempotent.
    const call = leadStatusService.writeStatus.mock.calls[0][0];
    expect(call.sourceEventId).toBe(
      `yelp_send_403_archived_${YELP_LEAD_ID}`,
    );
  });

  it('does not call writeStatus for Thumbtack archive errors (Yelp-only carve-out)', async () => {
    const { svc, leadStatusService } = buildService({ platform: 'thumbtack' });

    await expect(
      svc.sendMessage(USER_ID, LEAD_PK, 'Hi'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(leadStatusService.writeStatus).not.toHaveBeenCalled();
  });

  it('still throws BadRequestException if writeStatus itself rejects (status write never masks the send failure)', async () => {
    const { svc, leadStatusService } = buildService({ platform: 'yelp' });
    leadStatusService.writeStatus.mockRejectedValueOnce(new Error('db down'));

    await expect(
      svc.sendMessage(USER_ID, LEAD_PK, 'Hi'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(leadStatusService.writeStatus).toHaveBeenCalled();
  });
});
