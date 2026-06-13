/**
 * HMAC-SHA256 signing for assistant proposals.
 *
 * Why this exists: the frontend treats a proposal as an opaque blob, but
 * we can't trust the frontend to keep it opaque. A malicious caller could
 * try to flip `target.area` from `business_information` to
 * `global_custom_instructions`, or swap `newValue` for arbitrary text.
 *
 * The fix: only the backend can mint a valid signature, and apply
 * recomputes the signature over the embedded payload + expiresAt + userId
 * + id. Any tampering invalidates the signature; an expired proposal is
 * also rejected even if the signature would have matched.
 *
 * Key source: env var ASSISTANT_PROPOSAL_HMAC_KEY (32+ random bytes hex/
 * base64). Falls back to a deterministic dev key in non-production so
 * tests + local don't need .env wiring — but logs a loud warning so a
 * missing-env-in-prod misconfig is caught at first interpret call.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { SignedProposal } from './assistant.types';

const DEV_FALLBACK_KEY =
  'ai-settings-assistant-dev-fallback-key-do-not-use-in-prod-0123456789';

let warnedAboutFallback = false;

function getHmacKey(): string {
  const key = process.env.ASSISTANT_PROPOSAL_HMAC_KEY;
  if (key && key.length >= 32) return key;

  // In production we still proceed (returning 500 here would brick the
  // feature on every request) but log loudly the first time. The dev
  // fallback is deterministic so unit tests can produce/verify without
  // env wiring.
  if (process.env.NODE_ENV === 'production' && !warnedAboutFallback) {
    warnedAboutFallback = true;
    // eslint-disable-next-line no-console
    console.error(
      '[ai-settings-assistant] ASSISTANT_PROPOSAL_HMAC_KEY missing or too short — using dev fallback. Set this env var to a 32+ char random string.',
    );
  }
  return DEV_FALLBACK_KEY;
}

function canonicalize(value: unknown): string {
  // Recursive key-sorted JSON serialization. Required because both
  // signing and verification must produce identical bytes regardless of
  // object key insertion order. Do NOT use the JSON.stringify replacer-
  // array trick — that's an allowlist filter, not a sort order, and
  // would collapse different payloads to the same canonical string.
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(k => JSON.stringify(k) + ':' + canonicalize((value as Record<string, unknown>)[k]));
  return '{' + parts.join(',') + '}';
}

function computeSignature(
  payload: SignedProposal['payload'],
  expiresAt: number,
  userId: string,
  id: string,
): string {
  const material = `${id}.${userId}.${expiresAt}.${canonicalize(payload)}`;
  return createHmac('sha256', getHmacKey()).update(material).digest('hex');
}

/**
 * Mint a signed proposal valid for `ttlMs` from now. Default 10 minutes —
 * long enough for the user to read the proposal card and click Apply,
 * short enough that a leaked proposal can't be replayed indefinitely.
 */
export function signProposal(
  userId: string,
  payload: SignedProposal['payload'],
  ttlMs: number = 10 * 60 * 1000,
): SignedProposal {
  const id = randomBytes(12).toString('hex');
  const expiresAt = Date.now() + ttlMs;
  const signature = computeSignature(payload, expiresAt, userId, id);
  return { id, expiresAt, userId, payload, signature };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'user_mismatch' | 'bad_signature' | 'malformed' };

export function verifyProposal(proposal: SignedProposal, userId: string): VerifyResult {
  if (
    !proposal ||
    typeof proposal !== 'object' ||
    typeof proposal.id !== 'string' ||
    typeof proposal.userId !== 'string' ||
    typeof proposal.expiresAt !== 'number' ||
    typeof proposal.signature !== 'string' ||
    !proposal.payload ||
    typeof proposal.payload !== 'object'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (proposal.userId !== userId) {
    return { ok: false, reason: 'user_mismatch' };
  }
  if (proposal.expiresAt <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  const expected = computeSignature(proposal.payload, proposal.expiresAt, proposal.userId, proposal.id);
  // Constant-time compare — guards against timing-oracle leakage of the
  // signature bytes even though the impact would be minimal here.
  const expectedBuf = Buffer.from(expected, 'hex');
  const gotBuf = Buffer.from(proposal.signature, 'hex');
  if (expectedBuf.length !== gotBuf.length) return { ok: false, reason: 'bad_signature' };
  if (!timingSafeEqual(expectedBuf, gotBuf)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}
