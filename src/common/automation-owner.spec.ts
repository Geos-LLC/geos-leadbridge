import { Logger } from '@nestjs/common';
import { isAutomationOwner, logSkippedAutomation } from './automation-owner';

describe('isAutomationOwner', () => {
  const ORIGINAL = process.env.AUTOMATION_OWNER;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.AUTOMATION_OWNER;
    else process.env.AUTOMATION_OWNER = ORIGINAL;
  });

  it('returns true only on the literal string "true"', () => {
    process.env.AUTOMATION_OWNER = 'true';
    expect(isAutomationOwner()).toBe(true);
  });

  it('returns false when unset (staging default)', () => {
    delete process.env.AUTOMATION_OWNER;
    expect(isAutomationOwner()).toBe(false);
  });

  it.each(['false', '0', '1', 'yes', 'TRUE', 'True', ''])('returns false on %s (no truthy-string coercion)', (v) => {
    process.env.AUTOMATION_OWNER = v;
    expect(isAutomationOwner()).toBe(false);
  });
});

describe('logSkippedAutomation', () => {
  it('logs at warn level with a stable prefix and source/context payload', () => {
    const logger = new Logger('Test');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    logSkippedAutomation(logger, 'restorePendingMessages', { leadId: 'abc' });
    expect(warn).toHaveBeenCalledWith(
      '[automation-owner] not owner — skipping restorePendingMessages {"leadId":"abc"}',
    );
  });
});
