/**
 * LeadsController.getLeadActivity tests.
 *
 * Covers the tenant guard, response shape, the limit cap, and the
 * not-found branch. Other endpoints on this controller already have
 * coverage via test/security/* and leads.service.spec.ts.
 */

import { LeadsController } from './leads.controller';

const USER_ID = 'user-1';
const OTHER_USER = 'user-other';
const LEAD_ID = 'lead-42';

function buildController(opts: {
  ownerId?: string;
  rows?: any[];
} = {}) {
  const ownerId = opts.ownerId ?? USER_ID;
  const rows = opts.rows ?? [];

  const prisma: any = {
    lead: {
      findFirst: jest.fn(({ where }: any) => {
        if (where.id === LEAD_ID && where.userId === ownerId) {
          return { id: LEAD_ID };
        }
        return null;
      }),
    },
    leadStatusAuditLog: {
      findMany: jest.fn().mockResolvedValue(rows),
    },
  };

  const controller = new LeadsController(
    /* leadsService */ {} as any,
    /* leadStatusService */ {} as any,
    /* eventEmitter */ {} as any,
    prisma,
    /* crmWebhookService */ {} as any,
  );
  return { controller, prisma };
}

describe('LeadsController.getLeadActivity', () => {
  it('returns activity rows in API shape for the owner', async () => {
    const occurredAt = new Date('2026-04-28T12:00:00Z');
    const createdAt = new Date('2026-04-28T12:00:00.500Z');
    const { controller, prisma } = buildController({
      rows: [
        {
          id: 'audit-1',
          activityType: 'status_changed',
          oldStatus: 'engaged',
          newStatus: 'lost',
          source: 'lb_automation',
          reason: 'opt_out',
          metadata: { trigger: 'msg-99' },
          actorType: 'system',
          actorName: null,
          occurredAt,
          createdAt,
        },
      ],
    });

    const res = await controller.getLeadActivity({ id: USER_ID }, LEAD_ID);

    expect(res.success).toBe(true);
    expect(res.activity).toEqual([
      {
        id: 'audit-1',
        type: 'status_changed',
        fromStatus: 'engaged',
        toStatus: 'lost',
        source: 'lb_automation',
        reason: 'opt_out',
        metadata: { trigger: 'msg-99' },
        actorType: 'system',
        actorName: null,
        occurredAt,
        createdAt,
      },
    ]);

    // Tenant guard: looked up by (id, userId).
    expect(prisma.lead.findFirst).toHaveBeenCalledWith({
      where: { id: LEAD_ID, userId: USER_ID },
      select: { id: true },
    });
  });

  it('blocks cross-tenant reads (returns success=false, empty activity)', async () => {
    const { controller, prisma } = buildController({ ownerId: OTHER_USER });

    const res = await controller.getLeadActivity({ id: USER_ID }, LEAD_ID);

    expect(res.success).toBe(false);
    expect(res.error).toBe('Lead not found');
    expect(res.activity).toEqual([]);
    // Audit table must not be queried when tenant guard fails.
    expect(prisma.leadStatusAuditLog.findMany).not.toHaveBeenCalled();
  });

  it('defaults limit to 50 and orders by createdAt desc', async () => {
    const { controller, prisma } = buildController();

    await controller.getLeadActivity({ id: USER_ID }, LEAD_ID);

    expect(prisma.leadStatusAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { leadId: LEAD_ID },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    );
  });

  it('caps limit at 200 even when caller asks for more', async () => {
    const { controller, prisma } = buildController();

    await controller.getLeadActivity({ id: USER_ID }, LEAD_ID, '5000');

    expect(prisma.leadStatusAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });

  it('clamps non-positive limit values back to 1', async () => {
    const { controller, prisma } = buildController();

    await controller.getLeadActivity({ id: USER_ID }, LEAD_ID, '0');

    expect(prisma.leadStatusAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1 }),
    );
  });

  it('falls back to default 50 when limit is non-numeric', async () => {
    const { controller, prisma } = buildController();

    await controller.getLeadActivity({ id: USER_ID }, LEAD_ID, 'abc');

    expect(prisma.leadStatusAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
  });

  it('returns success=true with empty activity array when no rows', async () => {
    const { controller } = buildController({ rows: [] });

    const res = await controller.getLeadActivity({ id: USER_ID }, LEAD_ID);

    expect(res.success).toBe(true);
    expect(res.activity).toEqual([]);
  });
});
