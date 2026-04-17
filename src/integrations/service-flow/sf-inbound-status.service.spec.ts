/**
 * SfInboundStatusService tests.
 *
 * Covers the full inbound pipeline: HMAC verification, idempotency, lookup,
 * loop-prevention, status mapping, conditional writes, and follow-up reaction.
 */

import * as crypto from 'crypto';
import { SfInboundStatusService, SfJobStatusPayload } from './sf-inbound-status.service';

const SUB_ID = 'sub-1';
const SECRET = 'test-secret-0123';
const USER_ID = 'user-1';
const LEAD_ID = 'lead-1';
const JOB_ID = 'sfjob-1';
const CONV_ID = 'conv-1';

function buildPrismaMock() {
  const mock: any = {
    crmWebhookSubscription: {
      findUnique: jest.fn().mockResolvedValue({
        id: SUB_ID,
        userId: USER_ID,
        secret: SECRET,
        isActive: true,
        direction: 'inbound',
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    sfInboundEvent: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'evt-row', ...data })),
    },
    lead: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    followUpEnrollment: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    leadStatusAuditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
  };
  return mock;
}

function buildConfig(overrides: Record<string, string> = {}) {
  const defaults: Record<string, string> = {
    SF_INBOUND_WEBHOOK_ENABLED: 'true',
    SF_INBOUND_WEBHOOK_DRY_RUN: 'false',
  };
  return {
    get: jest.fn((k: string, def?: string) => (k in overrides ? overrides[k] : defaults[k] ?? def)),
  } as any;
}

function buildEngine() {
  return {
    stopEnrollment: jest.fn().mockResolvedValue(undefined),
    switchToLongTermMode: jest.fn().mockResolvedValue(true),
    switchToShortTermMode: jest.fn().mockResolvedValue(true),
    isEngaged: jest.fn().mockResolvedValue(false),
  } as any;
}

function sign(timestamp: string, body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function basePayload(overrides: Partial<SfJobStatusPayload> = {}): SfJobStatusPayload {
  return {
    event_id: 'evt-' + crypto.randomUUID(),
    event_type: 'job.status_changed',
    occurred_at: new Date().toISOString(),
    source: 'service_flow',
    sf_job_id: JOB_ID,
    status: { new: 'completed', previous: 'in-progress' },
    ...overrides,
  };
}

function okLead(overrides: Partial<any> = {}) {
  return {
    id: LEAD_ID,
    userId: USER_ID,
    threadId: CONV_ID,
    status: 'contacted',
    sfJobId: null,
    sfLastEventAt: null,
    statusSource: null,
    statusUpdatedAt: null,
    ...overrides,
  };
}

describe('SfInboundStatusService', () => {
  let prisma: ReturnType<typeof buildPrismaMock>;
  let engine: ReturnType<typeof buildEngine>;
  let service: SfInboundStatusService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    engine = buildEngine();
    service = new SfInboundStatusService(prisma, buildConfig(), engine);
  });

  // --------------------------------------------------------------
  // ingest() — HMAC + header validation
  // --------------------------------------------------------------

  describe('ingest (HMAC + headers)', () => {
    it('rejects with 401 when headers missing', async () => {
      const r = await service.ingest('{}', {});
      expect(r.httpStatus).toBe(401);
      expect(r.result).toBe('unauthorized');
    });

    it('rejects with 401 on timestamp drift > 300s', async () => {
      const body = JSON.stringify(basePayload());
      const oldTs = String(Math.floor(Date.now() / 1000) - 600);
      const r = await service.ingest(body, {
        signature: sign(oldTs, body, SECRET),
        timestamp: oldTs,
        subscriptionId: SUB_ID,
      });
      expect(r.httpStatus).toBe(401);
    });

    it('rejects with 404 when subscription not found', async () => {
      prisma.crmWebhookSubscription.findUnique.mockResolvedValue(null);
      const body = JSON.stringify(basePayload());
      const ts = String(Math.floor(Date.now() / 1000));
      const r = await service.ingest(body, {
        signature: sign(ts, body, SECRET),
        timestamp: ts,
        subscriptionId: SUB_ID,
      });
      expect(r.httpStatus).toBe(404);
    });

    it('rejects with 401 on signature mismatch', async () => {
      const body = JSON.stringify(basePayload());
      const ts = String(Math.floor(Date.now() / 1000));
      const r = await service.ingest(body, {
        signature: sign(ts, body, 'WRONG-SECRET'),
        timestamp: ts,
        subscriptionId: SUB_ID,
      });
      expect(r.httpStatus).toBe(401);
      expect(r.result).toBe('unauthorized');
    });

    it('accepts signature in sha256=<hex> format', async () => {
      prisma.lead.findFirst.mockResolvedValue(okLead({ status: 'completed' })); // already same → noop
      const payload = basePayload();
      const body = JSON.stringify(payload);
      const ts = String(Math.floor(Date.now() / 1000));
      const hex = sign(ts, body, SECRET);
      const r = await service.ingest(body, {
        signature: `sha256=${hex}`,
        timestamp: ts,
        subscriptionId: SUB_ID,
      });
      expect(r.httpStatus).toBe(200);
    });

    it('returns 400 on malformed JSON', async () => {
      const body = '{not-json';
      const ts = String(Math.floor(Date.now() / 1000));
      const r = await service.ingest(body, {
        signature: sign(ts, body, SECRET),
        timestamp: ts,
        subscriptionId: SUB_ID,
      });
      expect(r.httpStatus).toBe(400);
    });

    it('returns 400 when required field missing', async () => {
      const bad = { event_id: 'x', event_type: 'job.status_changed', occurred_at: new Date().toISOString() };
      const body = JSON.stringify(bad);
      const ts = String(Math.floor(Date.now() / 1000));
      const r = await service.ingest(body, {
        signature: sign(ts, body, SECRET),
        timestamp: ts,
        subscriptionId: SUB_ID,
      });
      expect(r.httpStatus).toBe(400);
    });

    it('returns 400 when SF_INBOUND_WEBHOOK_ENABLED=false', async () => {
      service = new SfInboundStatusService(prisma, buildConfig({ SF_INBOUND_WEBHOOK_ENABLED: 'false' }), engine);
      const r = await service.ingest('{}', {});
      expect(r.httpStatus).toBe(400);
    });

    it('returns 409 on duplicate event_id (idempotency)', async () => {
      const payload = basePayload();
      prisma.sfInboundEvent.findUnique.mockResolvedValue({
        id: 'existing', eventId: payload.event_id, leadId: LEAD_ID, status: 'applied',
      });
      const body = JSON.stringify(payload);
      const ts = String(Math.floor(Date.now() / 1000));
      const r = await service.ingest(body, {
        signature: sign(ts, body, SECRET),
        timestamp: ts,
        subscriptionId: SUB_ID,
      });
      expect(r.httpStatus).toBe(409);
      expect(r.result).toBe('applied');
      expect(r.leadId).toBe(LEAD_ID);
    });
  });

  // --------------------------------------------------------------
  // process() — core pipeline
  // --------------------------------------------------------------

  describe('process — lookup', () => {
    it('prefers sfJobId lookup', async () => {
      prisma.lead.findFirst.mockResolvedValueOnce(okLead({ sfJobId: JOB_ID }));
      const r = await service.process(basePayload(), { id: SUB_ID, userId: USER_ID });
      expect(r.httpStatus).toBe(200);
      expect(prisma.lead.findFirst).toHaveBeenCalledWith({
        where: { sfJobId: JOB_ID, userId: USER_ID },
      });
    });

    it('falls back to (platform, externalRequestId) when sfJobId miss', async () => {
      prisma.lead.findFirst
        .mockResolvedValueOnce(null) // first (sfJobId) miss
        .mockResolvedValueOnce(okLead()); // fallback hit

      const r = await service.process(
        basePayload({ external_request_id: 'tt_neg_1', channel: 'thumbtack' }),
        { id: SUB_ID, userId: USER_ID },
      );
      expect(r.httpStatus).toBe(200);
      expect(prisma.lead.findFirst).toHaveBeenNthCalledWith(2, {
        where: { userId: USER_ID, platform: 'thumbtack', externalRequestId: 'tt_neg_1' },
      });
    });

    it('returns 200/deferred when lead not found', async () => {
      prisma.lead.findFirst.mockResolvedValue(null);
      const r = await service.process(basePayload(), { id: SUB_ID, userId: USER_ID });
      expect(r.httpStatus).toBe(200);
      expect(r.result).toBe('deferred');
      expect(prisma.sfInboundEvent.create).toHaveBeenCalled();
    });
  });

  describe('process — loop guard', () => {
    it('skips when event is older than last SF-sourced write', async () => {
      const past = new Date('2026-04-16T10:00:00Z');
      const evt = new Date('2026-04-16T09:00:00Z');
      prisma.lead.findFirst.mockResolvedValue(okLead({
        statusSource: 'service_flow',
        sfLastEventAt: past,
      }));

      const r = await service.process(
        basePayload({ occurred_at: evt.toISOString(), status: { new: 'completed' } }),
        { id: SUB_ID, userId: USER_ID },
      );
      expect(r.result).toBe('stale');
      expect(prisma.lead.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('process — status mapping', () => {
    it('returns 422 for unknown SF status', async () => {
      prisma.lead.findFirst.mockResolvedValue(okLead());
      const r = await service.process(
        basePayload({ status: { new: 'on_hold' } }),
        { id: SUB_ID, userId: USER_ID },
      );
      expect(r.httpStatus).toBe(422);
      expect(r.result).toBe('unmapped_status');
    });

    it('no-op when canonical status matches lead.status AND sfJobId set', async () => {
      prisma.lead.findFirst.mockResolvedValue(okLead({ status: 'completed', sfJobId: JOB_ID }));
      const r = await service.process(
        basePayload({ status: { new: 'completed' } }),
        { id: SUB_ID, userId: USER_ID },
      );
      expect(r.result).toBe('noop');
      expect(prisma.lead.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('process — dry run', () => {
    beforeEach(() => {
      service = new SfInboundStatusService(
        prisma,
        buildConfig({ SF_INBOUND_WEBHOOK_DRY_RUN: 'true' }),
        engine,
      );
    });

    it('records event but does not write to Lead', async () => {
      prisma.lead.findFirst.mockResolvedValue(okLead());
      const r = await service.process(basePayload(), { id: SUB_ID, userId: USER_ID });
      expect(r.result).toBe('dry_run');
      expect(prisma.lead.updateMany).not.toHaveBeenCalled();
      expect(prisma.sfInboundEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'dry_run' }),
        }),
      );
    });
  });

  describe('process — write + reaction', () => {
    it('writes Lead.status + audit log + records event (applied)', async () => {
      prisma.lead.findFirst.mockResolvedValue(okLead({ status: 'contacted' }));
      prisma.lead.updateMany.mockResolvedValue({ count: 1 });

      const r = await service.process(basePayload({ status: { new: 'completed' } }), {
        id: SUB_ID, userId: USER_ID,
      });

      expect(r.result).toBe('applied');
      expect(prisma.lead.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ id: LEAD_ID }),
        data: expect.objectContaining({
          status: 'completed',
          statusSource: 'service_flow',
          sfJobId: JOB_ID,
        }),
      });
      expect(prisma.leadStatusAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          leadId: LEAD_ID,
          oldStatus: 'contacted',
          newStatus: 'completed',
          source: 'service_flow',
        }),
      });
      expect(prisma.sfInboundEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'applied' }),
        }),
      );
    });

    it('returns stale when conditional updateMany count=0 (lost race)', async () => {
      prisma.lead.findFirst.mockResolvedValue(okLead());
      prisma.lead.updateMany.mockResolvedValue({ count: 0 });

      const r = await service.process(basePayload(), { id: SUB_ID, userId: USER_ID });
      expect(r.result).toBe('stale');
    });

    it('terminal status → stops active follow-up enrollments', async () => {
      prisma.lead.findFirst.mockResolvedValue(okLead());
      prisma.followUpEnrollment.findMany.mockResolvedValue([
        { id: 'enroll-A' }, { id: 'enroll-B' },
      ]);

      await service.process(basePayload({ status: { new: 'completed' } }), {
        id: SUB_ID, userId: USER_ID,
      });

      expect(engine.stopEnrollment).toHaveBeenCalledWith('enroll-A', 'sf_status_completed');
      expect(engine.stopEnrollment).toHaveBeenCalledWith('enroll-B', 'sf_status_completed');
    });

    it('no_show → switches enrollment to long-term (not stop)', async () => {
      prisma.lead.findFirst.mockResolvedValue(okLead());
      prisma.followUpEnrollment.findFirst.mockResolvedValue({ id: 'enroll-X' });

      await service.process(basePayload({ status: { new: 'no-show' } }), {
        id: SUB_ID, userId: USER_ID,
      });

      expect(engine.stopEnrollment).not.toHaveBeenCalled();
      expect(engine.switchToLongTermMode).toHaveBeenCalledWith('enroll-X', 'sf_no_show');
    });

    it('non-terminal status → no enrollment action', async () => {
      prisma.lead.findFirst.mockResolvedValue(okLead({ status: 'new' }));

      await service.process(basePayload({ status: { new: 'pending' } }), {
        id: SUB_ID, userId: USER_ID,
      });

      expect(engine.stopEnrollment).not.toHaveBeenCalled();
      expect(engine.switchToLongTermMode).not.toHaveBeenCalled();
    });
  });
});
