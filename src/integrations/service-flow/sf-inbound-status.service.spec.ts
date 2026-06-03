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
      // Switched create→upsert (Issue: failed-event idempotency trap fix).
      // Mock returns the merged shape so any assertion that inspects the
      // call args via `expect(...upsert).toHaveBeenCalledWith(...)` works.
      upsert: jest.fn().mockImplementation((args: any) =>
        Promise.resolve({ id: 'evt-row', eventId: args.where.eventId, ...args.create }),
      ),
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

function buildLeadStatus() {
  // Default behavior: every writeStatus call applies. Individual tests
  // override .mockResolvedValueOnce(...) to simulate skip outcomes.
  return {
    writeStatus: jest.fn().mockImplementation(async (input: any) => ({
      leadId: input.leadId,
      applied: true,
      status: input.newStatus,
      platformStatus: null,
      conflict: null,
      auditLogId: 'audit-' + crypto.randomUUID(),
    })),
    // Phase 1 SF lifecycle mirror — shared helper. Live SF webhook calls
    // this before writeStatus, independent of canonical write guards.
    // Default returns written=true; tests asserting stale-protection
    // override via mockResolvedValueOnce({ written: false }).
    writeSfJobOutcomeMirror: jest.fn().mockResolvedValue({ written: true }),
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
    // Fields read by the enrichment helper. Tests that exercise the response
    // shape rely on these being populated; tests that don't are unaffected.
    platform: 'yelp',
    externalRequestId: 'M7SgM8SY8slQdmBB1pcD7A',
    platformStatus: null,
    thumbtackStatus: null,
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
  let leadStatus: ReturnType<typeof buildLeadStatus>;
  let service: SfInboundStatusService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    engine = buildEngine();
    leadStatus = buildLeadStatus();
    service = new SfInboundStatusService(prisma, buildConfig(), engine, leadStatus);
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
      service = new SfInboundStatusService(prisma, buildConfig({ SF_INBOUND_WEBHOOK_ENABLED: 'false' }), engine, leadStatus);
      const r = await service.ingest('{}', {});
      expect(r.httpStatus).toBe(400);
    });

    it('returns 409 on duplicate event_id with prior status=applied (idempotency)', async () => {
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

    // ── Failed-event idempotency trap fix ──────────────────────────────
    // Prior outcome was NOT successful (unmapped_status / unauthorized /
    // deferred). SF replay must flow through to process() and apply the
    // new outcome — failure rows are intentionally replayable. writeStatus
    // is still the final safety net against double application.
    it.each([['noop'], ['stale'], ['dry_run']])(
      'returns 409 on duplicate event_id with prior status=%s (still successful)',
      async (priorStatus) => {
        const payload = basePayload();
        prisma.sfInboundEvent.findUnique.mockResolvedValue({
          id: 'existing', eventId: payload.event_id, leadId: LEAD_ID, status: priorStatus,
        });
        const body = JSON.stringify(payload);
        const ts = String(Math.floor(Date.now() / 1000));
        const r = await service.ingest(body, {
          signature: sign(ts, body, SECRET),
          timestamp: ts,
          subscriptionId: SUB_ID,
        });
        expect(r.httpStatus).toBe(409);
        expect(r.result).toBe(priorStatus);
      },
    );

    it.each([['unmapped_status'], ['unauthorized'], ['deferred']])(
      'does NOT dedupe when prior status=%s — failure rows are replayable',
      async (priorStatus) => {
        const payload = basePayload({ status: { new: 'scheduled' } });
        // Prior failure row exists in dedup storage for this event_id.
        prisma.sfInboundEvent.findUnique.mockResolvedValue({
          id: 'existing', eventId: payload.event_id, leadId: LEAD_ID, status: priorStatus,
        });
        // Lead now exists + status now mappable → replay should succeed.
        prisma.lead.findFirst.mockResolvedValue(
          okLead({ status: 'new', sfJobId: JOB_ID }),
        );
        const body = JSON.stringify(payload);
        const ts = String(Math.floor(Date.now() / 1000));
        const r = await service.ingest(body, {
          signature: sign(ts, body, SECRET),
          timestamp: ts,
          subscriptionId: SUB_ID,
        });
        // Replay flowed through — applied via writeStatus, NOT 409 duplicate.
        expect(r.httpStatus).toBe(200);
        expect(r.result).toBe('applied');
        expect(leadStatus.writeStatus).toHaveBeenCalledWith(
          expect.objectContaining({ newStatus: 'scheduled', source: 'service_flow' }),
        );
      },
    );

    it('writeStatus dedup catches a replayed event that leaks through (final safety net)', async () => {
      // Pathological scenario: a successful-outcome row somehow has its
      // status spoofed to a failure value, bypassing the outer dedup. The
      // (leadId, source, sourceEventId) audit-log dedup inside writeStatus
      // still prevents double-application. Receiver surfaces it as `stale`.
      const payload = basePayload({ status: { new: 'scheduled' } });
      prisma.sfInboundEvent.findUnique.mockResolvedValue({
        id: 'existing', eventId: payload.event_id, leadId: LEAD_ID, status: 'unmapped_status',
      });
      prisma.lead.findFirst.mockResolvedValue(okLead({ sfJobId: JOB_ID, status: 'new' }));
      leadStatus.writeStatus.mockResolvedValueOnce({
        leadId: LEAD_ID,
        applied: false,
        status: 'scheduled',
        platformStatus: null,
        conflict: null,
        auditLogId: null,
        skipReason: 'duplicate',
      });
      const body = JSON.stringify(payload);
      const ts = String(Math.floor(Date.now() / 1000));
      const r = await service.ingest(body, {
        signature: sign(ts, body, SECRET),
        timestamp: ts,
        subscriptionId: SUB_ID,
      });
      expect(r.httpStatus).toBe(200);
      expect(r.result).toBe('stale');
      expect(r.skipReason).toBe('duplicate');
    });

    it('replay UPSERTs the dedup row, preserving eventId and overwriting failure outcome', async () => {
      const payload = basePayload({ status: { new: 'scheduled' } });
      prisma.sfInboundEvent.findUnique.mockResolvedValue({
        id: 'existing', eventId: payload.event_id, leadId: LEAD_ID, status: 'unmapped_status',
      });
      prisma.lead.findFirst.mockResolvedValue(okLead({ sfJobId: JOB_ID, status: 'new' }));
      const body = JSON.stringify(payload);
      const ts = String(Math.floor(Date.now() / 1000));
      await service.ingest(body, {
        signature: sign(ts, body, SECRET),
        timestamp: ts,
        subscriptionId: SUB_ID,
      });
      // Upsert by unique eventId — Create-on-miss / Update-on-hit semantics.
      expect(prisma.sfInboundEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { eventId: payload.event_id },
          create: expect.objectContaining({ status: 'applied' }),
          update: expect.objectContaining({ status: 'applied' }),
        }),
      );
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
      expect(prisma.sfInboundEvent.upsert).toHaveBeenCalled();
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
      expect(leadStatus.writeStatus).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Primary-job guard — LB status follows ONLY the first SF job per lead.
  // Later SF jobs for the same customer (recurring/follow-up bookings)
  // resolve to the same Lead via the (platform, externalRequestId)
  // fallback. Without this guard their status writes would mutate
  // Lead.status and create false drift (Casey Hill / Oriana / Erin /
  // Derek incidents). The fix relies on Lead.sfJobId being first-write-
  // wins sticky — already enforced at the writeStatus extraLeadUpdates
  // site (`sfJobId: lead.sfJobId || payload.sf_job_id`).
  // ──────────────────────────────────────────────────────────────────
  describe('process — primary-job guard', () => {
    const PRIMARY_JOB = 'sfjob-primary-1';
    const FOLLOWUP_JOB = 'sfjob-followup-2';

    it('primary job — status update flows through writeStatus', async () => {
      // Lead has sfJobId === incoming payload.sf_job_id → guard does NOT trip.
      prisma.lead.findFirst.mockResolvedValue(
        okLead({ sfJobId: PRIMARY_JOB, status: 'contacted' }),
      );

      const r = await service.process(
        basePayload({ sf_job_id: PRIMARY_JOB, status: { new: 'completed' } }),
        { id: SUB_ID, userId: USER_ID },
      );

      expect(r.result).toBe('applied');
      expect(leadStatus.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({ newStatus: 'completed' }),
      );
    });

    it('follow-up job — ignored; LB status unchanged, noop logged with non_primary_job', async () => {
      prisma.lead.findFirst.mockResolvedValue(
        okLead({ sfJobId: PRIMARY_JOB, status: 'completed' }),
      );

      const r = await service.process(
        basePayload({ sf_job_id: FOLLOWUP_JOB, status: { new: 'scheduled' } }),
        { id: SUB_ID, userId: USER_ID },
      );

      expect(r.result).toBe('noop');
      expect(r.skipReason).toBe('non_primary_job');
      expect(leadStatus.writeStatus).not.toHaveBeenCalled();
      expect(prisma.sfInboundEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            status: 'noop',
            result: 'lead_status_skip:non_primary_job',
            sfJobId: FOLLOWUP_JOB,
            leadId: LEAD_ID,
          }),
        }),
      );
    });

    it('recurring customer with 5 jobs — only the primary mutates Lead.status', async () => {
      // Simulate 5 sequential webhook arrivals: 1 primary + 4 follow-ups.
      // - The primary iteration sends sf_job_id=PRIMARY with status 'completed',
      //   which maps cleanly and differs from the seed Lead.status='contacted',
      //   so it reaches writeStatus.
      // - The 4 follow-ups send different sf_job_ids → the primary-job guard
      //   trips before mapping (status string doesn't even need to be mappable).
      const jobs = [PRIMARY_JOB, 'sfjob-r2', 'sfjob-r3', 'sfjob-r4', 'sfjob-r5'];
      for (const jobId of jobs) {
        prisma.lead.findFirst.mockResolvedValueOnce(
          okLead({ sfJobId: PRIMARY_JOB, status: 'contacted' }),
        );
        const newStatus = jobId === PRIMARY_JOB ? 'completed' : 'confirmed';
        await service.process(
          basePayload({ sf_job_id: jobId, status: { new: newStatus } }),
          { id: SUB_ID, userId: USER_ID },
        );
      }
      // Only the primary should have reached the write path. The other 4
      // tripped the guard.
      expect(leadStatus.writeStatus).toHaveBeenCalledTimes(1);
      expect(leadStatus.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          extraLeadUpdates: expect.objectContaining({ sfJobId: PRIMARY_JOB }),
        }),
      );
      // The other 4 produced inbound-event noop rows with non_primary_job.
      const noopRows = (prisma.sfInboundEvent.upsert as jest.Mock).mock.calls
        .map((c) => c[0].create)
        .filter((d: any) => d.result === 'lead_status_skip:non_primary_job');
      expect(noopRows).toHaveLength(4);
      expect(noopRows.map((d: any) => d.sfJobId).sort()).toEqual(
        ['sfjob-r2', 'sfjob-r3', 'sfjob-r4', 'sfjob-r5'],
      );
    });

    it('first completed, then a later job becomes scheduled — LB stays completed', async () => {
      // The lead is already terminal from the primary job. The later
      // job's "scheduled" event arrives — guard must suppress it.
      prisma.lead.findFirst.mockResolvedValue(
        okLead({ sfJobId: PRIMARY_JOB, status: 'completed' }),
      );

      const r = await service.process(
        basePayload({ sf_job_id: FOLLOWUP_JOB, status: { new: 'scheduled' } }),
        { id: SUB_ID, userId: USER_ID },
      );

      expect(r.result).toBe('noop');
      expect(r.skipReason).toBe('non_primary_job');
      expect(r.currentStatus).toBe('completed');
      expect(leadStatus.writeStatus).not.toHaveBeenCalled();
    });

    it('first cancelled, then a later job becomes completed — LB stays cancelled', async () => {
      // Casey Hill–style case: the original conversion was cancelled and
      // the customer rebooked later under a separate SF job. The later
      // job's "completed" must not reopen / flip the LB lead.
      prisma.lead.findFirst.mockResolvedValue(
        okLead({ sfJobId: PRIMARY_JOB, status: 'cancelled' }),
      );

      const r = await service.process(
        basePayload({ sf_job_id: FOLLOWUP_JOB, status: { new: 'completed' } }),
        { id: SUB_ID, userId: USER_ID },
      );

      expect(r.result).toBe('noop');
      expect(r.skipReason).toBe('non_primary_job');
      expect(r.currentStatus).toBe('cancelled');
      expect(leadStatus.writeStatus).not.toHaveBeenCalled();
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
      expect(leadStatus.writeStatus).not.toHaveBeenCalled();
    });

    // ─── Issue #47 — SF lifecycle literals are no longer ignored ─────
    // Before this fix, SF outbox events with status.new='scheduled' /
    // 'booked' were dropped as unmapped_status (HTTP 422). Linked leads
    // stayed at Lead.status='new' even though SF had moved them through
    // the lifecycle. The three tests below pin the contract that SF
    // lifecycle status overrides LB lead-nurturing status when linked.

    it('SF scheduled payload on linked new lead → writeStatus(scheduled), applied', async () => {
      prisma.lead.findFirst.mockResolvedValue(
        okLead({ status: 'new', sfJobId: JOB_ID, platform: 'thumbtack' }),
      );

      const r = await service.process(
        basePayload({ status: { new: 'scheduled' } }),
        { id: SUB_ID, userId: USER_ID },
      );

      expect(r.httpStatus).toBe(200);
      expect(r.result).toBe('applied');
      expect(r.result).not.toBe('unmapped_status');
      expect(leadStatus.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          leadId: LEAD_ID,
          newStatus: 'scheduled',
          source: 'service_flow',
        }),
      );
      // Terminal → enrollment stop fired
      expect(engine.stopEnrollment).not.toHaveBeenCalled(); // no active enrollments mocked
    });

    it('SF booked payload on linked new lead → writeStatus(booked), applied', async () => {
      prisma.lead.findFirst.mockResolvedValue(
        okLead({ status: 'new', sfJobId: JOB_ID, platform: 'yelp' }),
      );

      const r = await service.process(
        basePayload({ status: { new: 'booked' } }),
        { id: SUB_ID, userId: USER_ID },
      );

      expect(r.httpStatus).toBe(200);
      expect(r.result).toBe('applied');
      expect(leadStatus.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({ newStatus: 'booked', source: 'service_flow' }),
      );
    });

    it('SF in_progress payload on linked contacted lead → writeStatus(in_progress)', async () => {
      prisma.lead.findFirst.mockResolvedValue(
        okLead({ status: 'contacted', sfJobId: JOB_ID }),
      );

      const r = await service.process(
        basePayload({ status: { new: 'in_progress' } }),
        { id: SUB_ID, userId: USER_ID },
      );

      expect(r.result).toBe('applied');
      expect(leadStatus.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({ newStatus: 'in_progress' }),
      );
    });

    it('SF completed payload on linked scheduled lead → writeStatus(completed) + stops follow-ups', async () => {
      prisma.lead.findFirst.mockResolvedValue(
        okLead({ status: 'scheduled', sfJobId: JOB_ID }),
      );
      prisma.followUpEnrollment.findMany.mockResolvedValue([{ id: 'enroll-Z' }]);

      const r = await service.process(
        basePayload({ status: { new: 'completed' } }),
        { id: SUB_ID, userId: USER_ID },
      );

      expect(r.result).toBe('applied');
      expect(leadStatus.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({ newStatus: 'completed' }),
      );
      expect(engine.stopEnrollment).toHaveBeenCalledWith('enroll-Z', 'sf_status_completed');
    });

    it('SF scheduled → writeStatus rejection with pipeline_downgrade still produces noop (downgrade guard preserved)', async () => {
      // Lead is already completed; SF event says scheduled. LeadStatusService
      // would reject this as a pipeline downgrade. The receiver must surface
      // that as noop (200), not flip the lead backwards.
      prisma.lead.findFirst.mockResolvedValue(
        okLead({ status: 'completed', sfJobId: JOB_ID, platformStatus: 'Done' }),
      );
      leadStatus.writeStatus.mockResolvedValueOnce({
        leadId: LEAD_ID,
        applied: false,
        status: 'completed',
        platformStatus: 'Done',
        conflict: null,
        auditLogId: null,
        skipReason: 'pipeline_downgrade',
      });

      const r = await service.process(
        basePayload({ status: { new: 'scheduled' } }),
        { id: SUB_ID, userId: USER_ID },
      );

      expect(r.result).toBe('noop');
      expect(r.skipReason).toBe('pipeline_downgrade');
      expect(r.currentStatus).toBe('completed');
    });
  });

  describe('process — dry run', () => {
    beforeEach(() => {
      service = new SfInboundStatusService(
        prisma,
        buildConfig({ SF_INBOUND_WEBHOOK_DRY_RUN: 'true' }),
        engine,
        leadStatus,
      );
    });

    it('records event but does not write to Lead', async () => {
      prisma.lead.findFirst.mockResolvedValue(okLead());
      const r = await service.process(basePayload(), { id: SUB_ID, userId: USER_ID });
      expect(r.result).toBe('dry_run');
      expect(leadStatus.writeStatus).not.toHaveBeenCalled();
      expect(prisma.sfInboundEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: 'dry_run' }),
        }),
      );
    });
  });

  describe('process — write + reaction', () => {
    it('writes Lead.status via LeadStatusService + records inbound event (applied)', async () => {
      prisma.lead.findFirst.mockResolvedValue(okLead({ status: 'contacted' }));

      const r = await service.process(basePayload({ status: { new: 'completed' } }), {
        id: SUB_ID, userId: USER_ID,
      });

      expect(r.result).toBe('applied');
      // LeadStatusService.writeStatus is now the single write path. It owns
      // the audit log row and the conditional update — we just verify the
      // contract we hand to it.
      expect(leadStatus.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          leadId: LEAD_ID,
          newStatus: 'completed',
          source: 'service_flow',
          sourceEventId: expect.stringMatching(/^evt-/),
          extraLeadUpdates: expect.objectContaining({
            sfJobId: JOB_ID,
            sfLastEventAt: expect.any(Date),
          }),
        }),
      );
      expect(prisma.sfInboundEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: 'applied' }),
        }),
      );
    });

    it('returns stale when LeadStatusService rejects with skipReason=stale_event', async () => {
      prisma.lead.findFirst.mockResolvedValue(okLead());
      leadStatus.writeStatus.mockResolvedValueOnce({
        leadId: LEAD_ID,
        applied: false,
        status: 'contacted',
        platformStatus: null,
        conflict: null,
        auditLogId: null,
        skipReason: 'stale_event',
      });

      const r = await service.process(basePayload(), { id: SUB_ID, userId: USER_ID });

      expect(r.result).toBe('stale');
      expect(prisma.sfInboundEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            status: 'stale',
            result: 'lead_status_skip:stale_event',
          }),
        }),
      );
    });

    it('returns stale when LeadStatusService rejects with skipReason=duplicate', async () => {
      prisma.lead.findFirst.mockResolvedValue(okLead());
      leadStatus.writeStatus.mockResolvedValueOnce({
        leadId: LEAD_ID,
        applied: false,
        status: 'contacted',
        platformStatus: null,
        conflict: null,
        auditLogId: null,
        skipReason: 'duplicate',
      });

      const r = await service.process(basePayload(), { id: SUB_ID, userId: USER_ID });

      expect(r.result).toBe('stale');
    });

    it('returns noop for other LeadStatusService skip reasons (hard_terminal, etc.)', async () => {
      prisma.lead.findFirst.mockResolvedValue(okLead());
      leadStatus.writeStatus.mockResolvedValueOnce({
        leadId: LEAD_ID,
        applied: false,
        status: 'contacted',
        platformStatus: null,
        conflict: null,
        auditLogId: null,
        skipReason: 'hard_terminal',
      });

      const r = await service.process(basePayload(), { id: SUB_ID, userId: USER_ID });

      expect(r.result).toBe('noop');
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

  describe('process — response enrichment for SF lifecycle_drift classifier', () => {
    // Every response that has a lead row must carry the enrichment block so
    // SF's drainer can populate its lifecycle_drift Loki anchor without an
    // extra round-trip.

    it('hard_terminal noop returns skipReason + currentStatus + platform context', async () => {
      // The Phase C smoke shape: lead is archived (Yelp scrape), SF event
      // sends scheduled, writeStatus rejects with hard_terminal.
      prisma.lead.findFirst.mockResolvedValue(
        okLead({
          status: 'archived',
          platformStatus: 'archived',
          platform: 'yelp',
          externalRequestId: 'M7SgM8SY8slQdmBB1pcD7A',
        }),
      );
      leadStatus.writeStatus.mockResolvedValueOnce({
        leadId: LEAD_ID,
        applied: false,
        status: 'archived',
        platformStatus: 'archived',
        conflict: null,
        auditLogId: null,
        skipReason: 'hard_terminal',
      });

      const r = await service.process(
        basePayload({ status: { new: 'pending' } }),
        { id: SUB_ID, userId: USER_ID },
      );

      expect(r.result).toBe('noop');
      expect(r.skipReason).toBe('hard_terminal');
      expect(r.currentStatus).toBe('archived');
      expect(r.currentPlatformStatus).toBe('archived');
      expect(r.platform).toBe('yelp');
      expect(r.externalRequestId).toBe('M7SgM8SY8slQdmBB1pcD7A');
      expect(r.sfJobId).toBe(JOB_ID); // from payload (lead.sfJobId is null)
    });

    it('stale (stale_event from writeStatus) returns skipReason + currentStatus', async () => {
      prisma.lead.findFirst.mockResolvedValue(
        okLead({ status: 'scheduled', platformStatus: 'Scheduled', platform: 'thumbtack' }),
      );
      leadStatus.writeStatus.mockResolvedValueOnce({
        leadId: LEAD_ID,
        applied: false,
        status: 'scheduled',
        platformStatus: 'Scheduled',
        conflict: null,
        auditLogId: null,
        skipReason: 'stale_event',
      });

      const r = await service.process(basePayload(), { id: SUB_ID, userId: USER_ID });

      expect(r.result).toBe('stale');
      expect(r.skipReason).toBe('stale_event');
      expect(r.currentStatus).toBe('scheduled');
      expect(r.currentPlatformStatus).toBe('Scheduled');
      expect(r.platform).toBe('thumbtack');
    });

    it('duplicate returns skipReason and currentStatus', async () => {
      prisma.lead.findFirst.mockResolvedValue(okLead({ status: 'in_progress' }));
      leadStatus.writeStatus.mockResolvedValueOnce({
        leadId: LEAD_ID,
        applied: false,
        status: 'in_progress',
        platformStatus: null,
        conflict: null,
        auditLogId: null,
        skipReason: 'duplicate',
      });

      const r = await service.process(basePayload(), { id: SUB_ID, userId: USER_ID });

      expect(r.result).toBe('stale');
      expect(r.skipReason).toBe('duplicate');
      expect(r.currentStatus).toBe('in_progress');
    });

    it('pipeline_downgrade returns skipReason and currentStatus', async () => {
      prisma.lead.findFirst.mockResolvedValue(okLead({ status: 'completed' }));
      leadStatus.writeStatus.mockResolvedValueOnce({
        leadId: LEAD_ID,
        applied: false,
        status: 'completed',
        platformStatus: 'Done',
        conflict: null,
        auditLogId: null,
        skipReason: 'pipeline_downgrade',
      });

      const r = await service.process(
        basePayload({ status: { new: 'pending' } }),
        { id: SUB_ID, userId: USER_ID },
      );

      expect(r.result).toBe('noop');
      expect(r.skipReason).toBe('pipeline_downgrade');
      expect(r.currentStatus).toBe('completed');
      expect(r.currentPlatformStatus).toBe('Done');
    });

    it('loop-guard stale (older than last SF event) returns skipReason=older_than_last_sf_event + lead context', async () => {
      const past = new Date('2026-05-25T18:00:00Z');
      const evt = new Date('2026-05-25T17:30:00Z');
      // sfJobId on the lead matches payload.sf_job_id so the primary-job
      // guard passes through to the loop guard (the situation under test).
      prisma.lead.findFirst.mockResolvedValue(
        okLead({
          status: 'scheduled',
          platformStatus: 'Hired',
          statusSource: 'service_flow',
          sfLastEventAt: past,
          sfJobId: '142288',
        }),
      );

      const r = await service.process(
        basePayload({ sf_job_id: '142288', occurred_at: evt.toISOString(), status: { new: 'completed' } }),
        { id: SUB_ID, userId: USER_ID },
      );

      expect(r.result).toBe('stale');
      expect(r.skipReason).toBe('older_than_last_sf_event');
      expect(r.currentStatus).toBe('scheduled');
      expect(r.currentPlatformStatus).toBe('Hired');
      expect(r.sfJobId).toBe('142288');
    });

    it('status_unchanged noop returns skipReason + currentStatus', async () => {
      prisma.lead.findFirst.mockResolvedValue(
        okLead({ status: 'completed', sfJobId: JOB_ID, platformStatus: 'Done' }),
      );

      const r = await service.process(
        basePayload({ status: { new: 'completed' } }),
        { id: SUB_ID, userId: USER_ID },
      );

      expect(r.result).toBe('noop');
      expect(r.skipReason).toBe('status_unchanged');
      expect(r.currentStatus).toBe('completed');
      expect(r.currentPlatformStatus).toBe('Done');
    });

    it('applied response carries currentStatus + currentPlatformStatus (no skipReason)', async () => {
      prisma.lead.findFirst.mockResolvedValue(okLead({ status: 'contacted', platform: 'yelp' }));
      // Default leadStatus.writeStatus mock returns applied=true; let it ride.

      const r = await service.process(
        basePayload({ status: { new: 'completed' } }),
        { id: SUB_ID, userId: USER_ID },
      );

      expect(r.result).toBe('applied');
      expect(r.skipReason).toBeNull();
      // currentStatus reflects the freshly-written canonical (from writeResult).
      expect(r.currentStatus).toBeDefined();
      expect(r.platform).toBe('yelp');
      expect(r.externalRequestId).toBe('M7SgM8SY8slQdmBB1pcD7A');
    });

    it('deferred (lead_not_found) carries payload-side identifiers only', async () => {
      prisma.lead.findFirst.mockResolvedValue(null);

      const r = await service.process(
        basePayload({
          sf_job_id: '142288',
          external_request_id: 'M7SgM8SY8slQdmBB1pcD7A',
          channel: 'yelp',
        }),
        { id: SUB_ID, userId: USER_ID },
      );

      expect(r.result).toBe('deferred');
      expect(r.skipReason).toBe('lead_not_found');
      expect(r.sfJobId).toBe('142288');
      expect(r.externalRequestId).toBe('M7SgM8SY8slQdmBB1pcD7A');
      expect(r.platform).toBe('yelp');
      // Lead-side fields stay absent — no lead = no currentStatus.
      expect(r.currentStatus).toBeUndefined();
      expect(r.currentPlatformStatus).toBeUndefined();
    });

    it('writes Lead.sfJobOutcome on every successful path (Phase 1 mirror)', async () => {
      // Tests the Phase 1 SF operational lifecycle mirror. sfJobOutcome
      // is written regardless of whether the canonical Lead.status write
      // succeeds (carve-out, dedup, downgrade may all block that). The
      // mirror SQL lives inside LeadStatusService.writeSfJobOutcomeMirror;
      // here we just verify the receiver delegates to it with the right
      // args. The stale-protection clause is exercised in lead-status.service.spec.ts.
      prisma.lead.findFirst.mockResolvedValue(okLead({ status: 'contacted' }));

      const occurredAt = new Date('2026-05-25T17:30:19Z');
      await service.process(
        basePayload({
          occurred_at: occurredAt.toISOString(),
          status: { new: 'completed' },
        }),
        { id: SUB_ID, userId: USER_ID },
      );

      expect(leadStatus.writeSfJobOutcomeMirror).toHaveBeenCalledWith(
        LEAD_ID, 'completed', occurredAt,
        expect.objectContaining({ sfJobId: JOB_ID, userId: USER_ID }),
      );
    });

    it('writes Lead.sfJobOutcome even when LB canonical status is unchanged (no-op branch)', async () => {
      // SF resends the same status as LB has. LB returns noop, but the
      // mirror still fires to reflect "SF saying the same thing again."
      prisma.lead.findFirst.mockResolvedValue(
        okLead({ status: 'completed', sfJobId: JOB_ID }),
      );

      await service.process(
        basePayload({ status: { new: 'completed' } }),
        { id: SUB_ID, userId: USER_ID },
      );

      expect(leadStatus.writeSfJobOutcomeMirror).toHaveBeenCalledWith(
        LEAD_ID, 'completed', expect.any(Date), expect.any(Object),
      );
    });

    it('does NOT write sfJobOutcome on unmapped status (canonical=null)', async () => {
      prisma.lead.findFirst.mockResolvedValue(okLead());
      await service.process(
        basePayload({ status: { new: 'on_hold' } }),
        { id: SUB_ID, userId: USER_ID },
      );
      expect(leadStatus.writeSfJobOutcomeMirror).not.toHaveBeenCalled();
    });

    it('falls back currentPlatformStatus to legacy thumbtackStatus when platformStatus is null', async () => {
      prisma.lead.findFirst.mockResolvedValue(
        okLead({
          status: 'archived',
          platform: 'thumbtack',
          platformStatus: null,
          thumbtackStatus: 'Archived',
        }),
      );
      leadStatus.writeStatus.mockResolvedValueOnce({
        leadId: LEAD_ID,
        applied: false,
        status: 'archived',
        platformStatus: null,
        conflict: null,
        auditLogId: null,
        skipReason: 'hard_terminal',
      });

      const r = await service.process(
        basePayload({ status: { new: 'pending' } }),
        { id: SUB_ID, userId: USER_ID },
      );

      expect(r.currentPlatformStatus).toBe('Archived');
    });
  });
});
