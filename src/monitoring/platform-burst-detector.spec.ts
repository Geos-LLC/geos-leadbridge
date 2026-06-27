/**
 * Unit tests for the cross-tenant platform-burst detector.
 *
 * Covered behaviors:
 *   - recordPlatformFailure is cheap, synchronous, and doesn't throw
 *     (it's called from hot HTTP error paths in TT/Yelp adapters)
 *   - the sliding window prunes timestamps older than 15 minutes so
 *     memory stays bounded under sustained load
 *   - checkPlatformBursts fires notifyDevAlert *exactly* when the count
 *     in the window crosses the per-kind threshold, with the threshold
 *     baked into PLATFORM_BURST_THRESHOLDS in the source file
 *   - unknown kinds (forward-compat: a service records under a kind we
 *     haven't added a threshold for yet) record but never alert
 *
 * notifyDevAlert is stubbed because we only care that it was *called*
 * with the right shape — the SendGrid + dedup wiring is exercised by
 * the EmailService spec and Loki replays.
 */

import { MonitoringService } from './monitoring.service';

function buildSvc() {
  // The detector only needs `now`-based time math and the notifyDevAlert
  // method on the instance — nothing else gets touched. Construct with
  // a minimal stub for the optional ConfigService argument.
  const svc = new MonitoringService(
    null as any, // prisma — unused on the burst path
    { get: () => undefined } as any, // configService — unused
  );
  const notifySpy = jest.spyOn(svc, 'notifyDevAlert').mockResolvedValue();
  return { svc, notifySpy };
}

describe('platform burst detector', () => {
  describe('recordPlatformFailure', () => {
    it('is synchronous and does not throw', () => {
      const { svc } = buildSvc();
      expect(() => svc.recordPlatformFailure('thumbtack_getlead')).not.toThrow();
      expect(() => svc.recordPlatformFailure('thumbtack_getlead')).not.toThrow();
      expect(() => svc.recordPlatformFailure('thumbtack_getlead')).not.toThrow();
    });
  });

  describe('checkPlatformBursts', () => {
    it('fires notifyDevAlert when thumbtack_getlead crosses the 30-event threshold', async () => {
      const { svc, notifySpy } = buildSvc();
      for (let i = 0; i < 30; i++) svc.recordPlatformFailure('thumbtack_getlead');

      await svc.checkPlatformBursts();

      expect(notifySpy).toHaveBeenCalledTimes(1);
      const call = notifySpy.mock.calls[0][0];
      expect(call.kind).toBe('platform_burst_thumbtack_getlead');
      expect(call.subject).toContain('thumbtack_getlead burst');
      expect(call.subject).toContain('30');
      expect(call.context).toMatchObject({
        kind: 'thumbtack_getlead',
        count: 30,
        threshold: 30,
        windowMinutes: 15,
      });
    });

    it('stays silent when count is below threshold', async () => {
      const { svc, notifySpy } = buildSvc();
      for (let i = 0; i < 29; i++) svc.recordPlatformFailure('thumbtack_getlead');

      await svc.checkPlatformBursts();

      expect(notifySpy).not.toHaveBeenCalled();
    });

    it('fires for yelp_sendmessage at the 20-event threshold', async () => {
      const { svc, notifySpy } = buildSvc();
      for (let i = 0; i < 20; i++) svc.recordPlatformFailure('yelp_sendmessage');

      await svc.checkPlatformBursts();

      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(notifySpy.mock.calls[0][0].kind).toBe('platform_burst_yelp_sendmessage');
    });

    it('fires for webhook_handler_crash at the 3-event threshold', async () => {
      const { svc, notifySpy } = buildSvc();
      for (let i = 0; i < 3; i++) svc.recordPlatformFailure('webhook_handler_crash');

      await svc.checkPlatformBursts();

      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(notifySpy.mock.calls[0][0].kind).toBe('platform_burst_webhook_handler_crash');
    });

    it('records but does not alert for unknown kinds (forward-compat)', async () => {
      const { svc, notifySpy } = buildSvc();
      for (let i = 0; i < 100; i++) svc.recordPlatformFailure('something_new_we_havent_thresholded');

      await svc.checkPlatformBursts();

      expect(notifySpy).not.toHaveBeenCalled();
    });

    it('prunes events older than 15 minutes from the window', async () => {
      const { svc, notifySpy } = buildSvc();
      const realNow = Date.now;
      try {
        // Insert 25 events 30 minutes ago — these should be pruned.
        const t0 = realNow();
        Date.now = jest.fn(() => t0 - 30 * 60_000);
        for (let i = 0; i < 25; i++) svc.recordPlatformFailure('thumbtack_getlead');

        // Now insert 5 more "right now" — well under the threshold of 30.
        Date.now = jest.fn(() => t0);
        for (let i = 0; i < 5; i++) svc.recordPlatformFailure('thumbtack_getlead');

        await svc.checkPlatformBursts();

        // Only 5 are inside the 15-min window — below threshold, no alert.
        expect(notifySpy).not.toHaveBeenCalled();
      } finally {
        Date.now = realNow;
      }
    });

    it('isolates windows per kind (yelp burst does not affect thumbtack count)', async () => {
      const { svc, notifySpy } = buildSvc();
      for (let i = 0; i < 20; i++) svc.recordPlatformFailure('yelp_sendmessage');
      for (let i = 0; i < 10; i++) svc.recordPlatformFailure('thumbtack_getlead'); // below threshold

      await svc.checkPlatformBursts();

      // Only yelp fires; TT count of 10 stays under its threshold of 30.
      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(notifySpy.mock.calls[0][0].kind).toBe('platform_burst_yelp_sendmessage');
    });
  });
});
