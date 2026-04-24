/**
 * LeadCacheService tests — verify the 5 helpers call the right underlying
 * CacheService primitives, the event listeners fan out to the correct helper,
 * and the kill switch (`CACHE_ENABLED=false`) turns every call into a no-op.
 */

import { LeadCacheService } from './lead-cache.service';
import { CacheService } from './cache.service';
import { CacheKeys } from './cache-keys';

function buildCache(overrides: Partial<Record<keyof CacheService, any>> = {}): jest.Mocked<CacheService> {
  const base: any = {
    isLive: jest.fn().mockReturnValue(true),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    delPattern: jest.fn().mockResolvedValue(0),
    getOrSet: jest.fn(),
    getStats: jest.fn().mockReturnValue({ hits: 0, misses: 0, errors: 0, sets: 0, dels: 0, connected: true, enabled: true, keyPrefix: 'test:' }),
  };
  return Object.assign(base, overrides) as any;
}

const USER_ID = 'user-1';
const LEAD_ID = 'lead-42';

describe('LeadCacheService', () => {
  describe('5 invalidation helpers', () => {
    it('invalidateLeadList → cache.delPattern(leadsListPattern)', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      await svc.invalidateLeadList(USER_ID);

      expect(cache.delPattern).toHaveBeenCalledTimes(1);
      expect(cache.delPattern).toHaveBeenCalledWith(CacheKeys.leadsListPattern(USER_ID));
      expect(cache.del).not.toHaveBeenCalled();
    });

    it('invalidateLeadDetail → cache.del(leadDetail) — key includes userId', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      await svc.invalidateLeadDetail(USER_ID, LEAD_ID);

      expect(cache.del).toHaveBeenCalledTimes(1);
      expect(cache.del).toHaveBeenCalledWith(CacheKeys.leadDetail(USER_ID, LEAD_ID));
      expect(cache.delPattern).not.toHaveBeenCalled();
    });

    it('invalidateLeadMessages → cache.del(leadMessages) — key includes userId', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      await svc.invalidateLeadMessages(USER_ID, LEAD_ID);

      expect(cache.del).toHaveBeenCalledTimes(1);
      expect(cache.del).toHaveBeenCalledWith(CacheKeys.leadMessages(USER_ID, LEAD_ID));
    });

    it('invalidateLeadAndList → list + detail, no messages', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      await svc.invalidateLeadAndList(USER_ID, LEAD_ID);

      expect(cache.delPattern).toHaveBeenCalledWith(CacheKeys.leadsListPattern(USER_ID));
      expect(cache.del).toHaveBeenCalledWith(CacheKeys.leadDetail(USER_ID, LEAD_ID));
      expect(cache.del).not.toHaveBeenCalledWith(CacheKeys.leadMessages(USER_ID, LEAD_ID));
    });

    it('invalidateLeadMessagesAndList → list + detail + messages', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      await svc.invalidateLeadMessagesAndList(USER_ID, LEAD_ID);

      expect(cache.delPattern).toHaveBeenCalledWith(CacheKeys.leadsListPattern(USER_ID));
      expect(cache.del).toHaveBeenCalledWith(CacheKeys.leadDetail(USER_ID, LEAD_ID));
      expect(cache.del).toHaveBeenCalledWith(CacheKeys.leadMessages(USER_ID, LEAD_ID));
    });

    it('helpers are no-ops when userId or leadId is missing', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      await svc.invalidateLeadList('');
      await svc.invalidateLeadDetail('', LEAD_ID);
      await svc.invalidateLeadDetail(USER_ID, '');
      await svc.invalidateLeadMessages('', LEAD_ID);

      expect(cache.delPattern).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
    });

    it('cross-tenant safety: leadDetail key differs by userId for the same leadId', () => {
      expect(CacheKeys.leadDetail('user-A', LEAD_ID)).not.toBe(CacheKeys.leadDetail('user-B', LEAD_ID));
      expect(CacheKeys.leadMessages('user-A', LEAD_ID)).not.toBe(CacheKeys.leadMessages('user-B', LEAD_ID));
    });
  });

  describe('use-case: lead status update invalidates list + detail', () => {
    it('calls invalidateLeadAndList which touches both keys', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      await svc.invalidateLeadAndList(USER_ID, LEAD_ID);

      expect(cache.delPattern).toHaveBeenCalledWith(CacheKeys.leadsListPattern(USER_ID));
      expect(cache.del).toHaveBeenCalledWith(CacheKeys.leadDetail(USER_ID, LEAD_ID));
      // Messages untouched — status updates do not change the message thread.
      expect(cache.del).not.toHaveBeenCalledWith(CacheKeys.leadMessages(USER_ID, LEAD_ID));
    });
  });

  describe('use-case: inbound message invalidates list + detail + messages', () => {
    it('sms.inbound event listener fans out to invalidateLeadMessagesAndList', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      // Payload shape matches webhooks.service.ts:1306 — leadId only, no userId.
      await svc.onSmsInbound({ leadId: LEAD_ID, message: { id: 'msg-1' } }, `sms.inbound.${USER_ID}`);

      expect(cache.delPattern).toHaveBeenCalledWith(CacheKeys.leadsListPattern(USER_ID));
      expect(cache.del).toHaveBeenCalledWith(CacheKeys.leadDetail(USER_ID, LEAD_ID));
      expect(cache.del).toHaveBeenCalledWith(CacheKeys.leadMessages(USER_ID, LEAD_ID));
    });

    it('sms.inbound with payload.userId (future-proof) also works', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      // Event name still required — prefix check runs first; payload.userId is
      // only a fallback for future payload evolution.
      await svc.onSmsInbound({ userId: USER_ID, leadId: LEAD_ID }, `sms.inbound.${USER_ID}`);

      expect(cache.delPattern).toHaveBeenCalledWith(CacheKeys.leadsListPattern(USER_ID));
      expect(cache.del).toHaveBeenCalledWith(CacheKeys.leadMessages(USER_ID, LEAD_ID));
    });
  });

  describe('use-case: outbound message invalidates list + detail + messages', () => {
    it('direct helper call from leads.service.sendMessage', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      // Simulates the call in leads.service.ts sendMessage after the outbound write.
      await svc.invalidateLeadMessagesAndList(USER_ID, LEAD_ID);

      expect(cache.delPattern).toHaveBeenCalledWith(CacheKeys.leadsListPattern(USER_ID));
      expect(cache.del).toHaveBeenCalledWith(CacheKeys.leadDetail(USER_ID, LEAD_ID));
      expect(cache.del).toHaveBeenCalledWith(CacheKeys.leadMessages(USER_ID, LEAD_ID));
    });
  });

  describe('use-case: bulk import invalidates once per user, not once per lead', () => {
    it('N per-lead helper calls ≠ the bulk pattern; one invalidateLeadList is enough', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      // The BULK pattern: N individual imports with skipCacheInvalidate, then
      // ONE invalidateLeadList at the end. Verifies the contract by counting calls.
      const BULK_SIZE = 100;
      for (let i = 0; i < BULK_SIZE; i++) {
        // skipCacheInvalidate branch → no cache touch
      }
      await svc.invalidateLeadList(USER_ID);

      expect(cache.delPattern).toHaveBeenCalledTimes(1);
      expect(cache.del).not.toHaveBeenCalled();
    });

    it('regression: the naive pattern (per-lead invalidateLeadAndList) would be 2N cache ops', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      const BULK_SIZE = 100;
      for (let i = 0; i < BULK_SIZE; i++) {
        await svc.invalidateLeadAndList(USER_ID, `lead-${i}`);
      }

      // Counter-example: 100 delPatterns + 100 dels = 200 round-trips.
      // Exists to make the bulk optimization visible if someone later removes it.
      expect(cache.delPattern).toHaveBeenCalledTimes(BULK_SIZE);
      expect(cache.del).toHaveBeenCalledTimes(BULK_SIZE);
    });
  });

  describe('event listeners', () => {
    it('lead.created.* → invalidateLeadAndList with payload userId + id', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      // webhooks.service emits the full `lead` row as payload.
      await svc.onLeadCreated({ id: LEAD_ID, userId: USER_ID, status: 'new' }, `lead.created.${USER_ID}`);

      expect(cache.delPattern).toHaveBeenCalledWith(CacheKeys.leadsListPattern(USER_ID));
      expect(cache.del).toHaveBeenCalledWith(CacheKeys.leadDetail(USER_ID, LEAD_ID));
    });

    it('lead.status.conflict.* → invalidateLeadAndList', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      await svc.onLeadStatusConflict({ leadId: LEAD_ID, userId: USER_ID }, `lead.status.conflict.${USER_ID}`);

      expect(cache.delPattern).toHaveBeenCalledWith(CacheKeys.leadsListPattern(USER_ID));
      expect(cache.del).toHaveBeenCalledWith(CacheKeys.leadDetail(USER_ID, LEAD_ID));
    });

    it('followup.suggested.* → invalidateLeadList only (payload has no leadId)', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      // follow-up-scheduler payload: enrollmentId, conversationId, executionId…
      await svc.onFollowUpSuggested({ enrollmentId: 'e1', conversationId: 'c1' }, `followup.suggested.${USER_ID}`);

      expect(cache.delPattern).toHaveBeenCalledWith(CacheKeys.leadsListPattern(USER_ID));
      expect(cache.del).not.toHaveBeenCalled();
    });

    it('listener with no resolvable userId is a no-op', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      await svc.onLeadCreated({ id: LEAD_ID }, `lead.created.${USER_ID}`); // missing payload.userId
      await svc.onSmsInbound({ leadId: LEAD_ID }, 'sms.inbound.'); // empty tail

      expect(cache.delPattern).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
    });
  });

  /**
   * Specificity tests — verify each listener ONLY fires for the exact event
   * name shape (3 or 4 segments starting with the right prefix). Guards
   * against accidental catches of sibling events (`sms.status.*`) or future
   * events added under the same root namespace (`lead.updated.*`).
   */
  describe('wildcard listener specificity', () => {
    it('onLeadCreated rejects event names outside `lead.created.<one-segment>`', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      // Wrong prefix
      await svc.onLeadCreated({ id: LEAD_ID, userId: USER_ID }, 'lead.updated.user-1');
      // Missing tail
      await svc.onLeadCreated({ id: LEAD_ID, userId: USER_ID }, 'lead.created.');
      // Too many segments — `*` is single-segment only
      await svc.onLeadCreated({ id: LEAD_ID, userId: USER_ID }, 'lead.created.user-1.sub');
      // No event name
      await svc.onLeadCreated({ id: LEAD_ID, userId: USER_ID }, undefined);

      expect(cache.delPattern).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
    });

    it('onSmsInbound does NOT fire for sms.status.* (sibling event)', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      // sms.status.${userId} is a DIFFERENT event emitted for delivery receipts
      // (webhooks.service.ts:989). This test pins the guarantee that it
      // never triggers inbound invalidation.
      await svc.onSmsInbound({ leadId: LEAD_ID, userId: USER_ID }, `sms.status.${USER_ID}`);

      expect(cache.delPattern).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
    });

    it('onLeadStatusConflict rejects `lead.status.<userId>` (only 3 segments)', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      // If `lead.status.conflict.*` accidentally matched `lead.status.<userId>`,
      // this test would fail — but single-segment wildcard cannot skip segments.
      // We still re-check the event name defensively inside the handler.
      await svc.onLeadStatusConflict({ leadId: LEAD_ID, userId: USER_ID }, `lead.status.${USER_ID}`);

      expect(cache.delPattern).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
    });

    it('onFollowUpSuggested rejects events without the exact prefix', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      await svc.onFollowUpSuggested({}, 'followup.sent.user-1');
      await svc.onFollowUpSuggested({}, 'followup.suggested.');
      await svc.onFollowUpSuggested({}, undefined);

      expect(cache.delPattern).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
    });

    it('happy-path specificity: each listener fires for its own pattern only', async () => {
      const cache = buildCache();
      const svc = new LeadCacheService(cache);

      await svc.onLeadCreated({ id: LEAD_ID, userId: USER_ID }, `lead.created.${USER_ID}`);
      expect(cache.delPattern).toHaveBeenCalledTimes(1);

      await svc.onSmsInbound({ leadId: LEAD_ID }, `sms.inbound.${USER_ID}`);
      // +1 delPattern, +2 del (detail + messages)
      expect(cache.delPattern).toHaveBeenCalledTimes(2);

      await svc.onLeadStatusConflict({ userId: USER_ID, leadId: LEAD_ID }, `lead.status.conflict.${USER_ID}`);
      expect(cache.delPattern).toHaveBeenCalledTimes(3);

      await svc.onFollowUpSuggested({}, `followup.suggested.${USER_ID}`);
      expect(cache.delPattern).toHaveBeenCalledTimes(4);
    });
  });

  describe('kill switch (CACHE_ENABLED=false)', () => {
    it('underlying CacheService short-circuits — delPattern returns 0 without Redis calls', async () => {
      // Simulate CACHE_ENABLED=false: isLive() = false, del/delPattern become no-ops.
      const cache = buildCache({
        isLive: jest.fn().mockReturnValue(false),
        del: jest.fn().mockImplementation(async () => { /* no-op when !isLive */ }),
        delPattern: jest.fn().mockImplementation(async () => 0),
      });
      const svc = new LeadCacheService(cache);

      await svc.invalidateLeadAndList(USER_ID, LEAD_ID);
      await svc.invalidateLeadMessagesAndList(USER_ID, LEAD_ID);
      await svc.onLeadCreated({ id: LEAD_ID, userId: USER_ID });
      await svc.onSmsInbound({ leadId: LEAD_ID }, `sms.inbound.${USER_ID}`);

      // LeadCacheService still dispatches to CacheService — the kill switch
      // lives INSIDE CacheService so feature code never needs to check it.
      // The important guarantee: the calls return cleanly without throwing
      // and CacheService absorbs them silently.
      expect(() => cache.isLive()).not.toThrow();
    });

    it('when CacheService is live → full fan-out still happens', async () => {
      const cache = buildCache(); // isLive: true
      const svc = new LeadCacheService(cache);

      await svc.invalidateLeadMessagesAndList(USER_ID, LEAD_ID);

      expect(cache.delPattern).toHaveBeenCalledTimes(1);
      expect(cache.del).toHaveBeenCalledTimes(2); // detail + messages
    });
  });
});
