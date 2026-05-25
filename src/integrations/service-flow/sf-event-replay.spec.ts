import { isReplayEligible } from './sf-event-replay';

describe('isReplayEligible', () => {
  describe('always-replayable statuses', () => {
    it.each([
      ['deferred', null],
      ['deferred', 'lead_not_found'],
      ['unmapped_status', 'unmapped_status:foo'],
      ['dry_run', 'would_apply:scheduled'],
      ['stale', 'lead_status_skip:stale_event'],
      ['stale', 'lead_status_skip:duplicate'],
    ])('allows status=%s result=%s', (status, result) => {
      const r = isReplayEligible({ status, result });
      expect(r.replayable).toBe(true);
    });
  });

  describe('noop with recoverable guard reasons', () => {
    it.each([
      ['hard_terminal'],
      ['stale_event'],
      ['duplicate'],
      ['pipeline_downgrade'],
    ])('allows noop + lead_status_skip:%s', (skip) => {
      const r = isReplayEligible({ status: 'noop', result: `lead_status_skip:${skip}` });
      expect(r.replayable).toBe(true);
      expect(r.reason).toBe(`noop+${skip}`);
    });
  });

  describe('noop with non-recoverable guard reasons', () => {
    it.each([
      ['no_change'],
      ['invalid_status'],
      ['sf_protected'],
      ['automation_terminal'],
    ])('blocks noop + lead_status_skip:%s', (skip) => {
      const r = isReplayEligible({ status: 'noop', result: `lead_status_skip:${skip}` });
      expect(r.replayable).toBe(false);
      expect(r.reason).toBe(`noop+${skip}_not_replayable`);
    });
  });

  describe('noop benign results', () => {
    it.each([
      ['status_unchanged'],
      ['subscription_not_found'],
      ['missing_sf_job_id'],
      ['invalid_json'],
      [''],
    ])('blocks noop + result=%s', (result) => {
      const r = isReplayEligible({ status: 'noop', result: result || null });
      expect(r.replayable).toBe(false);
      expect(r.reason).toMatch(/^noop_benign:/);
    });
  });

  describe('terminal statuses', () => {
    it('blocks applied', () => {
      const r = isReplayEligible({ status: 'applied', result: 'archived→scheduled' });
      expect(r.replayable).toBe(false);
      expect(r.reason).toBe('status=applied');
    });

    it('blocks unauthorized', () => {
      const r = isReplayEligible({ status: 'unauthorized', result: 'signature_mismatch' });
      expect(r.replayable).toBe(false);
      expect(r.reason).toBe('status=unauthorized');
    });
  });
});
