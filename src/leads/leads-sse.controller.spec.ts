/**
 * LeadsController.leadEvents — account-scope filtering of the SSE stream.
 *
 * Drives the real rxjs pipeline by wiring a real EventEmitter2 into the
 * controller, subscribing to the returned Observable, then emitting events
 * through the emitter. Each test asserts which envelope shapes the
 * subscriber received.
 */

import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, MessageEvent } from '@nestjs/common';
import { firstValueFrom, Subject } from 'rxjs';
import { take, toArray, takeUntil, tap } from 'rxjs/operators';
import { LeadsController } from './leads.controller';

const USER = { id: 'user-1' };

function buildController(opts: {
  leadsByPair?: Record<string, { businessId: string | null }>;
} = {}) {
  const findFirstCalls: Array<{ id: string; userId: string }> = [];
  const prisma: any = {
    lead: {
      findFirst: jest.fn(async ({ where, select }: any) => {
        findFirstCalls.push({ id: where.id, userId: where.userId });
        if (where.userId !== USER.id) return null;
        return opts.leadsByPair?.[where.id] ?? null;
      }),
    },
  };
  const eventEmitter = new EventEmitter2();
  const controller = new LeadsController(
    /* leadsService */ {} as any,
    /* leadStatusService */ {} as any,
    eventEmitter,
    prisma,
    /* crmWebhookService */ {} as any,
  );
  return { controller, eventEmitter, prisma, findFirstCalls };
}

/**
 * Subscribe to the controller stream, then emit each (eventName, payload)
 * pair after a microtask. Returns the array of events that came out of the
 * stream up to `expectedCount`. Resolves after a short tick if fewer events
 * actually arrive (e.g. when filtering drops some).
 */
async function collect(
  controller: LeadsController,
  emitter: EventEmitter2,
  args: { businessId?: string; scope?: string },
  emissions: Array<{ name: string; payload: any }>,
  opts: { expectedCount: number; timeoutMs?: number } = { expectedCount: 0, timeoutMs: 200 },
): Promise<MessageEvent[]> {
  const stream = controller.leadEvents(USER, args.businessId, args.scope);
  const collected: MessageEvent[] = [];
  const stop$ = new Subject<void>();
  const sub = stream
    .pipe(
      tap((ev) => {
        if ((ev.data as any)?.type === 'heartbeat') return; // ignore the 30s heartbeat
        collected.push(ev);
        if (collected.length >= opts.expectedCount) stop$.next();
      }),
      takeUntil(stop$),
    )
    .subscribe();

  // Emit on next tick so the subscription is wired before events fire.
  await new Promise((r) => setImmediate(r));
  for (const e of emissions) {
    emitter.emit(e.name, e.payload);
  }

  // Give the async resolver mergeMap a chance to settle.
  await new Promise((r) => setTimeout(r, opts.timeoutMs ?? 200));
  sub.unsubscribe();
  return collected;
}

describe('LeadsController.leadEvents — account-scope filter', () => {
  describe('businessId scope', () => {
    it('lead.created → forwards events whose payload has matching businessId; drops non-matching', async () => {
      const { controller, eventEmitter } = buildController();

      const events = await collect(
        controller,
        eventEmitter,
        { businessId: 'biz-A' },
        [
          { name: `lead.created.${USER.id}`, payload: { id: 'l1', userId: USER.id, businessId: 'biz-A' } },
          { name: `lead.created.${USER.id}`, payload: { id: 'l2', userId: USER.id, businessId: 'biz-B' } },
          { name: `lead.created.${USER.id}`, payload: { id: 'l3', userId: USER.id, businessId: 'biz-A' } },
        ],
        { expectedCount: 2 },
      );

      expect(events).toHaveLength(2);
      expect((events[0].data as any).type).toBe('lead.created');
      expect((events[0].data as any).lead.id).toBe('l1');
      expect((events[1].data as any).lead.id).toBe('l3');
    });

    it('sms.inbound (only leadId in payload) → resolved via Prisma, filtered by businessId', async () => {
      const { controller, eventEmitter, findFirstCalls } = buildController({
        leadsByPair: {
          'lead-A': { businessId: 'biz-A' },
          'lead-B': { businessId: 'biz-B' },
        },
      });

      const events = await collect(
        controller,
        eventEmitter,
        { businessId: 'biz-A' },
        [
          { name: `sms.inbound.${USER.id}`, payload: { leadId: 'lead-A', message: { id: 'm1' } } },
          { name: `sms.inbound.${USER.id}`, payload: { leadId: 'lead-B', message: { id: 'm2' } } },
          { name: `sms.inbound.${USER.id}`, payload: { leadId: 'lead-A', message: { id: 'm3' } } },
        ],
        { expectedCount: 2 },
      );

      expect(events).toHaveLength(2);
      expect((events[0].data as any).message.id).toBe('m1');
      expect((events[1].data as any).message.id).toBe('m3');
      // Cache: lead-A and lead-B looked up once each.
      expect(findFirstCalls.filter((c) => c.id === 'lead-A')).toHaveLength(1);
      expect(findFirstCalls.filter((c) => c.id === 'lead-B')).toHaveLength(1);
    });

    it('sms.status (no leadId, no businessId) → unresolved → dropped from account-scoped stream', async () => {
      const { controller, eventEmitter } = buildController();

      const events = await collect(
        controller,
        eventEmitter,
        { businessId: 'biz-A' },
        [
          { name: `sms.status.${USER.id}`, payload: { messageId: 'msg-1', logId: 'log-1', status: 'delivered' } },
          { name: `sms.status.${USER.id}`, payload: { messageId: 'msg-2', logId: 'log-2', status: 'failed' } },
        ],
        { expectedCount: 0, timeoutMs: 150 },
      );

      expect(events).toHaveLength(0);
    });

    it('lead.status.conflict (only leadId) → resolved and filtered', async () => {
      const { controller, eventEmitter } = buildController({
        leadsByPair: { 'lead-A': { businessId: 'biz-A' }, 'lead-B': { businessId: 'biz-B' } },
      });

      const events = await collect(
        controller,
        eventEmitter,
        { businessId: 'biz-A' },
        [
          { name: `lead.status.conflict.${USER.id}`, payload: { leadId: 'lead-A', userId: USER.id, conflict: {} } },
          { name: `lead.status.conflict.${USER.id}`, payload: { leadId: 'lead-B', userId: USER.id, conflict: {} } },
        ],
        { expectedCount: 1 },
      );

      expect(events).toHaveLength(1);
      expect((events[0].data as any).leadId).toBe('lead-A');
    });

    it('lead with businessId=null is dropped from account-scoped stream', async () => {
      const { controller, eventEmitter } = buildController({
        leadsByPair: { 'lead-X': { businessId: null } },
      });

      const events = await collect(
        controller,
        eventEmitter,
        { businessId: 'biz-A' },
        [{ name: `sms.inbound.${USER.id}`, payload: { leadId: 'lead-X', message: { id: 'm1' } } }],
        { expectedCount: 0, timeoutMs: 150 },
      );

      expect(events).toHaveLength(0);
    });
  });

  describe('scope=all', () => {
    it('forwards every event regardless of businessId — no Prisma calls', async () => {
      const { controller, eventEmitter, findFirstCalls } = buildController();

      const events = await collect(
        controller,
        eventEmitter,
        { scope: 'all' },
        [
          { name: `lead.created.${USER.id}`, payload: { id: 'l1', userId: USER.id, businessId: 'biz-A' } },
          { name: `lead.created.${USER.id}`, payload: { id: 'l2', userId: USER.id, businessId: 'biz-B' } },
          { name: `sms.inbound.${USER.id}`, payload: { leadId: 'lead-Z', message: { id: 'm9' } } },
          { name: `sms.status.${USER.id}`, payload: { messageId: 'msg-1', status: 'delivered' } },
        ],
        { expectedCount: 4 },
      );

      expect(events).toHaveLength(4);
      // No DB calls: scope=all is a pure pass-through (resolver isn't invoked).
      expect(findFirstCalls).toHaveLength(0);
    });
  });

  describe('transition mode (no businessId, no scope)', () => {
    it('streams every event AND emits a structured warning log', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const { controller, eventEmitter } = buildController();

      const events = await collect(
        controller,
        eventEmitter,
        {},
        [
          { name: `lead.created.${USER.id}`, payload: { id: 'l1', userId: USER.id, businessId: 'biz-A' } },
          { name: `sms.status.${USER.id}`, payload: { messageId: 'msg-1', status: 'delivered' } },
        ],
        { expectedCount: 2 },
      );

      expect(events).toHaveLength(2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/account-boundary.*subscribed without businessId or scope=all/);

      warnSpy.mockRestore();
    });
  });

  describe('mutual exclusion', () => {
    it('businessId AND scope=all → 400', () => {
      const { controller } = buildController();

      expect(() => controller.leadEvents(USER, 'biz-A', 'all')).toThrow(BadRequestException);
    });
  });
});
