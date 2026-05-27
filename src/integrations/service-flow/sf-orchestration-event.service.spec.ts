import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { SfOrchestrationEventService } from './sf-orchestration-event.service';

function buildSvc(opts: {
  inboundEnabled?: boolean;
  subscription?: { id: string; userId: string; secret: string; isActive: boolean; direction: string } | null;
  lead?: { id: string; threadId: string | null; userId: string } | null;
  existingEvent?: { id: string; status: string; leadId: string | null } | null;
  orchestratorThrows?: boolean;
} = {}) {
  const calls: any = {
    sub: [],
    lead: [],
    inboundEvent: [],
    orchestrator: [],
  };

  const cfg = {
    get: ((k: string, def?: any) => {
      if (k === 'SF_ORCHESTRATION_INBOUND_ENABLED') return opts.inboundEnabled === true ? 'true' : 'false';
      return def;
    }) as any,
  } as ConfigService;

  const prisma: any = {
    crmWebhookSubscription: {
      findUnique: jest.fn(async (args: any) => {
        calls.sub.push(args);
        return opts.subscription ?? null;
      }),
    },
    lead: {
      findFirst: jest.fn(async (args: any) => {
        calls.lead.push(args);
        return opts.lead ?? null;
      }),
    },
    sfInboundEvent: {
      findUnique: jest.fn(async (args: any) => {
        calls.inboundEvent.push({ method: 'findUnique', args });
        return opts.existingEvent ?? null;
      }),
      create: jest.fn(async (args: any) => {
        calls.inboundEvent.push({ method: 'create', args });
        return args.data;
      }),
    },
  };

  const orchestrator: any = {
    handleServiceOutcomeEvent: jest.fn(async (input: any) => {
      calls.orchestrator.push(input);
      if (opts.orchestratorThrows) throw new Error('orchestrator boom');
    }),
  };

  const svc = new SfOrchestrationEventService(prisma, cfg, orchestrator);
  return { svc, prisma, orchestrator, calls };
}

function makeSignedRequest(payload: any, secret: string, opts: { tsSec?: number; sigOverride?: string } = {}) {
  const body = JSON.stringify(payload);
  const ts = String(opts.tsSec ?? Math.floor(Date.now() / 1000));
  const sig = opts.sigOverride
    ?? crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return { rawBody: body, headers: { signature: sig, timestamp: ts, subscriptionId: 'sub-1' } };
}

const VALID_PAYLOAD = {
  event_id: 'evt-1',
  event_type: 'service_scheduled',
  occurred_at: '2026-05-27T19:00:00Z',
  sf_job_id: 'sf-1',
  scheduled_for: '2026-06-02T13:00:00Z',
};

const SUB = { id: 'sub-1', userId: 'u1', secret: 'shh-secret', isActive: true, direction: 'inbound' };
const LEAD = { id: 'lead1', threadId: 'conv1', userId: 'u1' };

describe('SfOrchestrationEventService.ingest()', () => {
  describe('endpoint kill-switch', () => {
    it('returns 400 noop when SF_ORCHESTRATION_INBOUND_ENABLED is unset (default)', async () => {
      const { svc, orchestrator } = buildSvc({ inboundEnabled: false });
      const req = makeSignedRequest(VALID_PAYLOAD, 'whatever');
      const out = await svc.ingest(req.rawBody, req.headers);
      expect(out.httpStatus).toBe(400);
      expect(out.result).toBe('noop');
      expect(orchestrator.handleServiceOutcomeEvent).not.toHaveBeenCalled();
    });
  });

  describe('HMAC verification', () => {
    it('returns 401 when headers are missing', async () => {
      const { svc } = buildSvc({ inboundEnabled: true, subscription: SUB });
      const out = await svc.ingest(JSON.stringify(VALID_PAYLOAD), {});
      expect(out.httpStatus).toBe(401);
      expect(out.result).toBe('unauthorized');
    });

    it('returns 401 when timestamp drift exceeds 300s', async () => {
      const { svc } = buildSvc({ inboundEnabled: true, subscription: SUB });
      const tsOld = Math.floor(Date.now() / 1000) - 400;
      const req = makeSignedRequest(VALID_PAYLOAD, SUB.secret, { tsSec: tsOld });
      const out = await svc.ingest(req.rawBody, req.headers);
      expect(out.httpStatus).toBe(401);
      expect(out.error).toBe('timestamp drift');
    });

    it('returns 404 when subscription not found', async () => {
      const { svc } = buildSvc({ inboundEnabled: true, subscription: null });
      const req = makeSignedRequest(VALID_PAYLOAD, 'wrong');
      const out = await svc.ingest(req.rawBody, req.headers);
      expect(out.httpStatus).toBe(404);
      expect(out.result).toBe('noop');
    });

    it('returns 401 on signature mismatch', async () => {
      const { svc } = buildSvc({ inboundEnabled: true, subscription: SUB });
      const req = makeSignedRequest(VALID_PAYLOAD, SUB.secret, { sigOverride: 'a'.repeat(64) });
      const out = await svc.ingest(req.rawBody, req.headers);
      expect(out.httpStatus).toBe(401);
      expect(out.error).toBe('signature_mismatch');
    });

    it('accepts sha256= prefixed signature', async () => {
      const { svc, orchestrator } = buildSvc({ inboundEnabled: true, subscription: SUB, lead: LEAD });
      const body = JSON.stringify(VALID_PAYLOAD);
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = 'sha256=' + crypto.createHmac('sha256', SUB.secret).update(`${ts}.${body}`).digest('hex');
      const out = await svc.ingest(body, { signature: sig, timestamp: ts, subscriptionId: 'sub-1' });
      expect(out.httpStatus).toBe(200);
      expect(orchestrator.handleServiceOutcomeEvent).toHaveBeenCalled();
    });
  });

  describe('Payload validation', () => {
    it('rejects unknown event_type', async () => {
      const { svc } = buildSvc({ inboundEnabled: true, subscription: SUB });
      const req = makeSignedRequest({ ...VALID_PAYLOAD, event_type: 'service_started' }, SUB.secret);
      const out = await svc.ingest(req.rawBody, req.headers);
      expect(out.httpStatus).toBe(400);
      expect(out.result).toBe('validation_failed');
      expect(out.error).toBe('unknown event_type');
    });

    it('rejects missing event_id', async () => {
      const { svc } = buildSvc({ inboundEnabled: true, subscription: SUB });
      const req = makeSignedRequest({ ...VALID_PAYLOAD, event_id: '' }, SUB.secret);
      const out = await svc.ingest(req.rawBody, req.headers);
      expect(out.httpStatus).toBe(400);
      expect(out.error).toBe('missing event_id');
    });

    it('rejects missing sf_job_id', async () => {
      const { svc } = buildSvc({ inboundEnabled: true, subscription: SUB });
      const req = makeSignedRequest({ ...VALID_PAYLOAD, sf_job_id: undefined }, SUB.secret);
      const out = await svc.ingest(req.rawBody, req.headers);
      expect(out.httpStatus).toBe(400);
      expect(out.error).toBe('missing sf_job_id');
    });

    it('rejects malformed JSON', async () => {
      const { svc } = buildSvc({ inboundEnabled: true, subscription: SUB });
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = crypto.createHmac('sha256', SUB.secret).update(`${ts}.not-json`).digest('hex');
      const out = await svc.ingest('not-json', { signature: sig, timestamp: ts, subscriptionId: 'sub-1' });
      expect(out.httpStatus).toBe(400);
      expect(out.error).toBe('invalid json');
    });

    it.each(['service_scheduled', 'service_rescheduled', 'service_cancelled', 'service_completed'])(
      'accepts %s',
      async (eventType) => {
        const { svc, orchestrator } = buildSvc({ inboundEnabled: true, subscription: SUB, lead: LEAD });
        const req = makeSignedRequest({ ...VALID_PAYLOAD, event_type: eventType }, SUB.secret);
        const out = await svc.ingest(req.rawBody, req.headers);
        expect(out.httpStatus).toBe(200);
        expect(orchestrator.handleServiceOutcomeEvent.mock.calls[0][0].eventType).toBe(eventType);
      },
    );
  });

  describe('Idempotency', () => {
    it('returns 409 duplicate when eventId already in sfInboundEvent', async () => {
      const { svc, orchestrator } = buildSvc({
        inboundEnabled: true,
        subscription: SUB,
        lead: LEAD,
        existingEvent: { id: 'row-1', status: 'applied', leadId: 'lead1' },
      });
      const req = makeSignedRequest(VALID_PAYLOAD, SUB.secret);
      const out = await svc.ingest(req.rawBody, req.headers);
      expect(out.httpStatus).toBe(409);
      expect(out.result).toBe('duplicate');
      // Critical: do NOT re-deliver to the orchestrator on a duplicate
      expect(orchestrator.handleServiceOutcomeEvent).not.toHaveBeenCalled();
    });
  });

  describe('Lead resolution', () => {
    it('returns 202 deferred when no lead found', async () => {
      const { svc, orchestrator, prisma } = buildSvc({
        inboundEnabled: true,
        subscription: SUB,
        lead: null,
      });
      const req = makeSignedRequest(VALID_PAYLOAD, SUB.secret);
      const out = await svc.ingest(req.rawBody, req.headers);
      expect(out.httpStatus).toBe(202);
      expect(out.result).toBe('deferred');
      expect(orchestrator.handleServiceOutcomeEvent).not.toHaveBeenCalled();
      // We persist the deferred event for replay later
      const createCall = prisma.sfInboundEvent.create.mock.calls[0]?.[0];
      expect(createCall?.data.status).toBe('deferred');
    });

    it('only matches leads of the calling subscription user (tenant isolation)', async () => {
      const { svc, prisma } = buildSvc({ inboundEnabled: true, subscription: SUB, lead: LEAD });
      const req = makeSignedRequest(VALID_PAYLOAD, SUB.secret);
      await svc.ingest(req.rawBody, req.headers);
      const leadCall = prisma.lead.findFirst.mock.calls[0][0];
      expect(leadCall.where.userId).toBe('u1');
    });
  });

  describe('Delegation to BookingOrchestratorService', () => {
    it('forwards normalized payload to handleServiceOutcomeEvent', async () => {
      const { svc, orchestrator } = buildSvc({ inboundEnabled: true, subscription: SUB, lead: LEAD });
      const req = makeSignedRequest(VALID_PAYLOAD, SUB.secret);
      await svc.ingest(req.rawBody, req.headers);
      const passed = orchestrator.handleServiceOutcomeEvent.mock.calls[0][0];
      expect(passed.eventId).toBe('evt-1');
      expect(passed.eventType).toBe('service_scheduled');
      expect(passed.sfJobId).toBe('sf-1');
      expect(passed.userId).toBe('u1');
      expect(passed.leadId).toBe('lead1');
      expect(passed.conversationId).toBe('conv1');
      expect(passed.scheduledFor).toBe('2026-06-02T13:00:00Z');
    });

    it('on orchestrator exception → returns 500 + persists exception row', async () => {
      const { svc, prisma } = buildSvc({
        inboundEnabled: true,
        subscription: SUB,
        lead: LEAD,
        orchestratorThrows: true,
      });
      const req = makeSignedRequest(VALID_PAYLOAD, SUB.secret);
      const out = await svc.ingest(req.rawBody, req.headers);
      expect(out.httpStatus).toBe(500);
      const createCall = prisma.sfInboundEvent.create.mock.calls[0]?.[0];
      expect(createCall?.data.status).toBe('noop');
      expect(createCall?.data.result).toBe('exception');
    });
  });

  describe('safety: no Lead.status writes from this path', () => {
    it('Service event ingest does not touch prisma.lead.update — only delegates to orchestrator (which uses updateMany on sfJobOutcome)', async () => {
      const { svc, prisma } = buildSvc({ inboundEnabled: true, subscription: SUB, lead: LEAD });
      const req = makeSignedRequest(VALID_PAYLOAD, SUB.secret);
      await svc.ingest(req.rawBody, req.headers);
      // The fake prisma doesn't have .update wired; assert that the
      // ingest code path didn't invent calls we'd need to add.
      expect((prisma.lead as any).update).toBeUndefined();
      expect((prisma.lead as any).updateMany).toBeUndefined();
    });
  });
});
