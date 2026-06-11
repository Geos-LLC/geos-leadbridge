/**
 * Tests for AnalyticsService.getSkippedLeads — the tenant-facing
 * skipped/refunded lead list that powers the new Analytics tab.
 *
 * Covers: dual-source merge (refundedAt path + stopped-enrollment path),
 * lead.id dedup with enrollment data preference, platform-side stop
 * reason filter, and date/business/platform scoping.
 */

import { AnalyticsService } from './analytics.service';

function buildPrismaMock() {
  return {
    lead: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    followUpEnrollment: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as any;
}

describe('AnalyticsService.getSkippedLeads', () => {
  let service: AnalyticsService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new AnalyticsService(prisma);
  });

  const baseQuery = { startDate: undefined, endDate: undefined, businessId: undefined, platform: undefined } as any;

  it('returns empty array when no leads match either path', async () => {
    const result = await service.getSkippedLeads('user-1', baseQuery);
    expect(result).toEqual([]);
  });

  it('refunded-only lead → single row with refund fields, no enrollment info', async () => {
    prisma.lead.findMany.mockResolvedValue([
      {
        id: 'lead-A',
        customerName: 'Gail Counter',
        platform: 'thumbtack',
        businessId: 'biz-1',
        customerPhone: null,
        customerPhoneSubstitute: null,
        createdAt: new Date('2026-04-30T20:50:23Z'),
        chargeStateRaw: 'Refunded',
        refundedAt: new Date('2026-06-11T16:35:59Z'),
        budgetVoidedAt: new Date('2026-06-11T16:35:59Z'),
      },
    ]);
    const result = await service.getSkippedLeads('user-1', baseQuery);
    expect(result).toHaveLength(1);
    expect(result[0].leadId).toBe('lead-A');
    expect(result[0].customerName).toBe('Gail Counter');
    expect(result[0].chargeStateRaw).toBe('Refunded');
    expect(result[0].refundedAt).toBeInstanceOf(Date);
    expect(result[0].budgetVoidedAt).toBeInstanceOf(Date);
    expect(result[0].enrollmentId).toBeNull();
    expect(result[0].stoppedReason).toBeNull();
  });

  it('stopped-enrollment-only lead → single row with enrollment info, no refund', async () => {
    prisma.followUpEnrollment.findMany.mockResolvedValue([
      {
        id: 'enr-1',
        stoppedReason: 'platform_thread_unreachable',
        completedAt: new Date('2026-06-11T15:00:00Z'),
        lead: {
          id: 'lead-B',
          customerName: 'Latoya Woodson',
          platform: 'thumbtack',
          businessId: 'biz-1',
          customerPhone: '9048746602',
          customerPhoneSubstitute: null,
          createdAt: new Date('2026-04-15T10:00:00Z'),
          chargeStateRaw: null,
          refundedAt: null,
          budgetVoidedAt: null,
        },
      },
    ]);
    const result = await service.getSkippedLeads('user-1', baseQuery);
    expect(result).toHaveLength(1);
    expect(result[0].leadId).toBe('lead-B');
    expect(result[0].enrollmentId).toBe('enr-1');
    expect(result[0].stoppedReason).toBe('platform_thread_unreachable');
    expect(result[0].stoppedAt).toBeInstanceOf(Date);
    expect(result[0].phone).toBe('9048746602');
    expect(result[0].refundedAt).toBeNull();
  });

  it('lead appearing on BOTH paths → single merged row, enrollment data wins', async () => {
    const sharedLead = {
      id: 'lead-C',
      customerName: 'Both Paths',
      platform: 'thumbtack',
      businessId: 'biz-1',
      customerPhone: '5551234567',
      customerPhoneSubstitute: null,
      createdAt: new Date('2026-05-01T00:00:00Z'),
      chargeStateRaw: 'Refunded',
      refundedAt: new Date('2026-06-10T00:00:00Z'),
      budgetVoidedAt: new Date('2026-06-10T00:00:00Z'),
    };
    prisma.lead.findMany.mockResolvedValue([sharedLead]);
    prisma.followUpEnrollment.findMany.mockResolvedValue([
      {
        id: 'enr-2',
        stoppedReason: 'platform_lead_removed_refunded',
        completedAt: new Date('2026-06-10T12:00:00Z'),
        lead: sharedLead,
      },
    ]);
    const result = await service.getSkippedLeads('user-1', baseQuery);
    expect(result).toHaveLength(1); // dedup'd
    expect(result[0].enrollmentId).toBe('enr-2'); // enrollment data preferred
    expect(result[0].stoppedReason).toBe('platform_lead_removed_refunded');
    expect(result[0].refundedAt).toBeInstanceOf(Date);
  });

  it('result is sorted newest-first by stoppedAt OR refundedAt', async () => {
    prisma.lead.findMany.mockResolvedValue([
      {
        id: 'old', customerName: 'Old', platform: 'thumbtack', businessId: 'biz-1',
        customerPhone: null, customerPhoneSubstitute: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        chargeStateRaw: 'Refunded',
        refundedAt: new Date('2026-05-01T00:00:00Z'),
        budgetVoidedAt: new Date('2026-05-01T00:00:00Z'),
      },
      {
        id: 'new', customerName: 'New', platform: 'thumbtack', businessId: 'biz-1',
        customerPhone: null, customerPhoneSubstitute: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        chargeStateRaw: 'Refunded',
        refundedAt: new Date('2026-06-11T00:00:00Z'),
        budgetVoidedAt: new Date('2026-06-11T00:00:00Z'),
      },
    ]);
    const result = await service.getSkippedLeads('user-1', baseQuery);
    expect(result.map(r => r.leadId)).toEqual(['new', 'old']);
  });

  it('filters by platform when query.platform is set', async () => {
    await service.getSkippedLeads('user-1', { ...baseQuery, platform: 'yelp' });
    const leadCall = (prisma.lead.findMany.mock.calls as any[][])[0][0];
    expect(leadCall.where.platform).toBe('yelp');
    const enrCall = (prisma.followUpEnrollment.findMany.mock.calls as any[][])[0][0];
    expect(enrCall.where.lead.platform).toBe('yelp');
  });

  it('filters by businessId when query.businessId is set', async () => {
    await service.getSkippedLeads('user-1', { ...baseQuery, businessId: 'biz-spotless' });
    const leadCall = (prisma.lead.findMany.mock.calls as any[][])[0][0];
    expect(leadCall.where.businessId).toBe('biz-spotless');
  });

  it('only queries stopped enrollments with platform-side reasons', async () => {
    await service.getSkippedLeads('user-1', baseQuery);
    const enrCall = (prisma.followUpEnrollment.findMany.mock.calls as any[][])[0][0];
    expect(enrCall.where.status).toBe('stopped');
    expect(enrCall.where.stoppedReason.in).toEqual(
      expect.arrayContaining([
        'platform_thread_unreachable',
        'platform_lead_removed_refunded',
        'platform_thread_closed',
        'platform_thread_archived',
      ]),
    );
  });

  it('phone substitute is used when customerPhone is null', async () => {
    prisma.lead.findMany.mockResolvedValue([
      {
        id: 'sub-only', customerName: 'Sub Only', platform: 'thumbtack', businessId: 'biz-1',
        customerPhone: null, customerPhoneSubstitute: '5559876543',
        createdAt: new Date('2026-05-01T00:00:00Z'),
        chargeStateRaw: null,
        refundedAt: new Date('2026-06-11T00:00:00Z'),
        budgetVoidedAt: new Date('2026-06-11T00:00:00Z'),
      },
    ]);
    const result = await service.getSkippedLeads('user-1', baseQuery);
    expect(result[0].phone).toBe('5559876543');
  });
});
