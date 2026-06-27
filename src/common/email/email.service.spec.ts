/**
 * EmailService tests — exercises the four behaviors callers care about:
 *
 *   1. No API key → returns false, never calls SendGrid (safe no-op so
 *      callers can fire-and-forget in dev without a key configured).
 *   2. Happy path → calls @sendgrid/mail with the exact payload shape we
 *      expect (this is the load-bearing assertion: every other consumer
 *      now relies on this transport, so the wire format matters).
 *   3. SendGrid throws → returns false instead of propagating, so a
 *      transient SendGrid outage can't break the caller's main flow.
 *   4. Defaults → unspecified fromEmail / fromName fall back to the
 *      env-driven configuration.
 *
 * `@sendgrid/mail` is `require()`'d inside EmailService so consumers don't
 * need its types at compile time; here we use jest.mock() to swap the
 * module out for a stub that records the calls.
 */

const sgSend = jest.fn();
const sgSetApiKey = jest.fn();

jest.mock('@sendgrid/mail', () => ({
  setApiKey: sgSetApiKey,
  send: sgSend,
}));

import { EmailService } from './email.service';

function buildConfig(overrides: Record<string, any> = {}) {
  const values: Record<string, any> = { ...overrides };
  return {
    get: jest.fn().mockImplementation((key: string) => values[key]),
  } as any;
}

describe('EmailService', () => {
  let prevApiKey: string | undefined;
  let prevFromEmail: string | undefined;

  beforeEach(() => {
    sgSend.mockReset();
    sgSetApiKey.mockReset();
    sgSend.mockResolvedValue([{ statusCode: 202 } as any, {}]);
    prevApiKey = process.env.SENDGRID_API_KEY;
    prevFromEmail = process.env.SENDGRID_FROM_EMAIL;
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_FROM_EMAIL;
  });

  afterEach(() => {
    if (prevApiKey === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = prevApiKey;
    if (prevFromEmail === undefined) delete process.env.SENDGRID_FROM_EMAIL;
    else process.env.SENDGRID_FROM_EMAIL = prevFromEmail;
  });

  describe('no API key', () => {
    it('returns false and never calls SendGrid', async () => {
      const svc = new EmailService(buildConfig());
      const ok = await svc.send({
        to: 'user@example.com',
        subject: 'hi',
        text: 'body',
      });
      expect(ok).toBe(false);
      expect(sgSetApiKey).not.toHaveBeenCalled();
      expect(sgSend).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('calls SendGrid with the full payload, returns true', async () => {
      const svc = new EmailService(buildConfig({ SENDGRID_API_KEY: 'SG.test', SENDGRID_FROM_EMAIL: 'alerts@example.com' }));
      const ok = await svc.send({
        to: 'user@example.com',
        subject: 'New tenant signed up',
        text: 'plain body',
        html: '<p>html body</p>',
        fromName: 'LeadBridge Ops',
        tag: 'auth/new-tenant-admin',
      });
      expect(ok).toBe(true);
      expect(sgSetApiKey).toHaveBeenCalledWith('SG.test');
      expect(sgSend).toHaveBeenCalledTimes(1);
      expect(sgSend).toHaveBeenCalledWith({
        to: 'user@example.com',
        from: { email: 'alerts@example.com', name: 'LeadBridge Ops' },
        subject: 'New tenant signed up',
        text: 'plain body',
        html: '<p>html body</p>',
      });
    });

    it('omits html field when caller did not provide one', async () => {
      const svc = new EmailService(buildConfig({ SENDGRID_API_KEY: 'SG.test', SENDGRID_FROM_EMAIL: 'alerts@example.com' }));
      await svc.send({ to: 'user@example.com', subject: 's', text: 't' });
      const payload = sgSend.mock.calls[0][0];
      expect(payload).not.toHaveProperty('html');
    });
  });

  describe('SendGrid throws', () => {
    it('returns false instead of propagating', async () => {
      sgSend.mockRejectedValueOnce(new Error('SendGrid 5xx'));
      const svc = new EmailService(buildConfig({ SENDGRID_API_KEY: 'SG.test', SENDGRID_FROM_EMAIL: 'alerts@example.com' }));
      const ok = await svc.send({ to: 'user@example.com', subject: 's', text: 't' });
      expect(ok).toBe(false);
    });
  });

  describe('defaults', () => {
    it('falls back to SENDGRID_FROM_EMAIL env when fromEmail not supplied', async () => {
      const svc = new EmailService(buildConfig({ SENDGRID_API_KEY: 'SG.test', SENDGRID_FROM_EMAIL: 'configured@example.com' }));
      await svc.send({ to: 'user@example.com', subject: 's', text: 't' });
      const payload = sgSend.mock.calls[0][0];
      expect(payload.from.email).toBe('configured@example.com');
    });

    it('falls back to alerts@leadbridge360.com when no fromEmail configured anywhere', async () => {
      const svc = new EmailService(buildConfig({ SENDGRID_API_KEY: 'SG.test' }));
      await svc.send({ to: 'user@example.com', subject: 's', text: 't' });
      const payload = sgSend.mock.calls[0][0];
      expect(payload.from.email).toBe('alerts@leadbridge360.com');
    });

    it('falls back to LeadBridge from-name when not supplied', async () => {
      const svc = new EmailService(buildConfig({ SENDGRID_API_KEY: 'SG.test', SENDGRID_FROM_EMAIL: 'alerts@example.com' }));
      await svc.send({ to: 'user@example.com', subject: 's', text: 't' });
      const payload = sgSend.mock.calls[0][0];
      expect(payload.from.name).toBe('LeadBridge');
    });

    it('uses process.env.SENDGRID_API_KEY when ConfigService returns nothing', async () => {
      process.env.SENDGRID_API_KEY = 'SG.from_env';
      const svc = new EmailService(buildConfig());
      const ok = await svc.send({ to: 'user@example.com', subject: 's', text: 't' });
      expect(ok).toBe(true);
      expect(sgSetApiKey).toHaveBeenCalledWith('SG.from_env');
    });
  });

  describe('explicit fromEmail override', () => {
    it('uses caller-supplied fromEmail over env default', async () => {
      const svc = new EmailService(buildConfig({ SENDGRID_API_KEY: 'SG.test', SENDGRID_FROM_EMAIL: 'env@example.com' }));
      await svc.send({
        to: 'user@example.com',
        subject: 's',
        text: 't',
        fromEmail: 'override@example.com',
      });
      const payload = sgSend.mock.calls[0][0];
      expect(payload.from.email).toBe('override@example.com');
    });
  });
});
