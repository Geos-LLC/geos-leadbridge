/**
 * OAuth state token — Phase 2C PR-C2.
 *
 * The `state` parameter in the OAuth redirect chain is LB's defense
 * against CSRF + replay during the SF connect handshake. It must:
 *
 *  - Bind the redirect to a specific LB user (so an attacker can't
 *    swap callbacks between tenants)
 *  - Bind the redirect to a specific pending SfConnection row id
 *  - Have a short TTL (15 min) so even a leaked state is short-lived
 *  - Be single-use — the callback handler marks it consumed so a
 *    replay (same `state` reused) is rejected
 *
 * Implementation: HMAC-signed envelope, encoded with base64url so it
 * survives query-param transport without further encoding. We do not
 * use a real JWT library to keep the dependency surface narrow.
 *
 * Envelope shape (signed):
 *   {
 *     v: 1,                       // schema version
 *     uid: <lb_user_id>,
 *     cid: <pending_connection_id>,
 *     nonce: <random 16 bytes hex>,  // uniqueness + dedup key
 *     iat: <unix seconds>,
 *     exp: <unix seconds>
 *   }
 *
 * Wire format: `${base64url(JSON)}.${base64url(HMAC-SHA256(JSON))}`
 *
 * The dedup key (single-use enforcement) is the `nonce`. The callback
 * handler stores consumed nonces in a tiny in-memory LRU + DB-backed
 * column on SfConnection (`stateNonceConsumed`); replay detection uses
 * whichever surfaces first. For PR-C2 we keep it on the pending row
 * itself since the row already has unique-by-userId — one in-flight
 * connect per user simplifies the design.
 */

import * as crypto from 'crypto';

const STATE_VERSION = 1;
const STATE_TTL_SECONDS = 15 * 60;

export interface StateEnvelope {
  v: number;
  uid: string;
  cid: string;
  nonce: string;
  iat: number;
  exp: number;
}

export interface StateValidationResult {
  ok: boolean;
  reason?:
    | 'malformed'
    | 'bad_signature'
    | 'expired'
    | 'version_mismatch'
    | 'missing_fields';
  envelope?: StateEnvelope;
}

export class SfStateToken {
  /** Sign a fresh state token. Returns the wire-format string. */
  static sign(
    args: { userId: string; pendingConnectionId: string },
    signingSecret: string,
  ): string {
    if (!args.userId) throw new Error('userId required');
    if (!args.pendingConnectionId) throw new Error('pendingConnectionId required');
    if (!signingSecret) throw new Error('signingSecret required');
    const now = Math.floor(Date.now() / 1000);
    const envelope: StateEnvelope = {
      v: STATE_VERSION,
      uid: args.userId,
      cid: args.pendingConnectionId,
      nonce: crypto.randomBytes(16).toString('hex'),
      iat: now,
      exp: now + STATE_TTL_SECONDS,
    };
    const body = base64url(Buffer.from(JSON.stringify(envelope), 'utf8'));
    const sig = base64url(
      crypto.createHmac('sha256', signingSecret).update(body).digest(),
    );
    return `${body}.${sig}`;
  }

  /**
   * Validate a wire-format state token. Returns `{ok: true, envelope}` on
   * success; otherwise `{ok: false, reason}`. Does NOT consume the
   * nonce — the caller is responsible for marking it used.
   */
  static validate(
    wire: string | undefined | null,
    signingSecret: string,
  ): StateValidationResult {
    if (!wire || typeof wire !== 'string') return { ok: false, reason: 'malformed' };
    const dot = wire.indexOf('.');
    if (dot <= 0 || dot === wire.length - 1) return { ok: false, reason: 'malformed' };
    const bodyEnc = wire.slice(0, dot);
    const sigEnc = wire.slice(dot + 1);

    let bodyBuf: Buffer;
    try {
      bodyBuf = base64urlDecode(bodyEnc);
    } catch {
      return { ok: false, reason: 'malformed' };
    }

    const expected = crypto.createHmac('sha256', signingSecret).update(bodyEnc).digest();
    const actual = (() => {
      try {
        return base64urlDecode(sigEnc);
      } catch {
        return null;
      }
    })();
    if (!actual || actual.length !== expected.length) {
      return { ok: false, reason: 'bad_signature' };
    }
    if (!crypto.timingSafeEqual(actual, expected)) {
      return { ok: false, reason: 'bad_signature' };
    }

    let env: StateEnvelope;
    try {
      env = JSON.parse(bodyBuf.toString('utf8'));
    } catch {
      return { ok: false, reason: 'malformed' };
    }

    if (env.v !== STATE_VERSION) return { ok: false, reason: 'version_mismatch' };
    if (typeof env.uid !== 'string' || !env.uid) {
      return { ok: false, reason: 'missing_fields' };
    }
    if (typeof env.cid !== 'string' || !env.cid) {
      return { ok: false, reason: 'missing_fields' };
    }
    if (typeof env.nonce !== 'string' || !env.nonce) {
      return { ok: false, reason: 'missing_fields' };
    }
    if (typeof env.exp !== 'number') return { ok: false, reason: 'missing_fields' };

    const now = Math.floor(Date.now() / 1000);
    if (env.exp < now) return { ok: false, reason: 'expired' };

    return { ok: true, envelope: env };
  }
}

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(normalized, 'base64');
}
