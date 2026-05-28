import { SfStateToken } from './sf-state-token.util';

const SECRET = 'state-token-test-secret-32-bytes-okay';

describe('SfStateToken', () => {
  describe('sign + validate happy path', () => {
    it('round-trips with correct envelope', () => {
      const wire = SfStateToken.sign(
        { userId: 'u1', pendingConnectionId: 'c1' },
        SECRET,
      );
      const v = SfStateToken.validate(wire, SECRET);
      expect(v.ok).toBe(true);
      expect(v.envelope?.uid).toBe('u1');
      expect(v.envelope?.cid).toBe('c1');
      expect(v.envelope?.v).toBe(1);
      expect(typeof v.envelope?.nonce).toBe('string');
      expect(v.envelope?.nonce.length).toBeGreaterThan(0);
    });

    it('nonce is unique across signings', () => {
      const a = SfStateToken.sign({ userId: 'u1', pendingConnectionId: 'c1' }, SECRET);
      const b = SfStateToken.sign({ userId: 'u1', pendingConnectionId: 'c1' }, SECRET);
      expect(a).not.toBe(b);
      const ea = SfStateToken.validate(a, SECRET).envelope!;
      const eb = SfStateToken.validate(b, SECRET).envelope!;
      expect(ea.nonce).not.toBe(eb.nonce);
    });
  });

  describe('signature tampering', () => {
    it('flips one byte in sig → bad_signature', () => {
      const wire = SfStateToken.sign({ userId: 'u1', pendingConnectionId: 'c1' }, SECRET);
      // Mangle the last char of the signature half.
      const dot = wire.indexOf('.');
      const sigEnd = wire.slice(-1);
      const replacement = sigEnd === 'A' ? 'B' : 'A';
      const tampered = wire.slice(0, -1) + replacement;
      const v = SfStateToken.validate(tampered, SECRET);
      expect(v.ok).toBe(false);
      expect(v.reason).toBe('bad_signature');
      // sanity: dot still present
      expect(tampered.indexOf('.')).toBe(dot);
    });

    it('different secret → bad_signature', () => {
      const wire = SfStateToken.sign({ userId: 'u1', pendingConnectionId: 'c1' }, SECRET);
      const v = SfStateToken.validate(wire, 'some-other-secret');
      expect(v.ok).toBe(false);
      expect(v.reason).toBe('bad_signature');
    });
  });

  describe('malformed inputs', () => {
    it.each([null, undefined, '', 'no-dot', '.', 'a.'])('rejects malformed input: %s', (v) => {
      const r = SfStateToken.validate(v as any, SECRET);
      expect(r.ok).toBe(false);
    });

    it('rejects body that decodes but is not JSON', () => {
      // Body part = base64url('not-json'), sig recomputed correctly
      const bodyEnc = Buffer.from('not-json', 'utf8')
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
      const crypto = require('crypto');
      const sig = crypto.createHmac('sha256', SECRET).update(bodyEnc).digest('base64')
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
      const wire = `${bodyEnc}.${sig}`;
      const v = SfStateToken.validate(wire, SECRET);
      expect(v.ok).toBe(false);
      expect(v.reason).toBe('malformed');
    });
  });

  describe('expiry', () => {
    it('rejects an expired token', () => {
      // Build an envelope by hand with exp in the past, signed correctly
      const crypto = require('crypto');
      const env = {
        v: 1,
        uid: 'u1',
        cid: 'c1',
        nonce: 'abc',
        iat: 1000,
        exp: 2000, // far past
      };
      const bodyEnc = Buffer.from(JSON.stringify(env), 'utf8').toString('base64')
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
      const sig = crypto.createHmac('sha256', SECRET).update(bodyEnc).digest('base64')
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
      const wire = `${bodyEnc}.${sig}`;
      const v = SfStateToken.validate(wire, SECRET);
      expect(v.ok).toBe(false);
      expect(v.reason).toBe('expired');
    });
  });

  describe('signing input safety', () => {
    it.each(['', null, undefined])('throws on missing userId %s', (uid) => {
      expect(() => SfStateToken.sign({ userId: uid as any, pendingConnectionId: 'c1' }, SECRET)).toThrow();
    });
    it.each(['', null, undefined])('throws on missing pendingConnectionId %s', (cid) => {
      expect(() => SfStateToken.sign({ userId: 'u1', pendingConnectionId: cid as any }, SECRET)).toThrow();
    });
    it('throws on missing signingSecret', () => {
      expect(() => SfStateToken.sign({ userId: 'u1', pendingConnectionId: 'c1' }, '')).toThrow();
    });
  });
});
