/**
 * Audit log sanitization
 *
 * Phase 2 policy:
 *   - Never persist message bodies, full PII, tokens, secrets, webhook
 *     payloads, AI prompts/responses, credentials.
 *   - If a phone number or email lands in a free-text field (e.g. `reason`),
 *     mask it to last-4 / first-char respectively before storing.
 *   - Cap free-text length to bound forensic-storage growth.
 *
 * The audit schema deliberately exposes no JSON `metadata` column — these
 * helpers exist for the one free-text input we accept (`reason`) and as a
 * defensive layer if a future caller passes raw values into other fields.
 */

const MAX_REASON_LENGTH = 240;

const PHONE_REGEX = /\+?\d[\d\s().-]{6,}\d/g;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Mask a phone number to its last 4 digits.
 *   "+1 (555) 123-4567" → "***4567"
 *   "+15551234567"      → "***4567"
 *   "12"                → "***"
 */
export function maskPhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-4)}`;
}

/**
 * Mask an email address to first-letter + domain.
 *   "alice@example.com"  → "a***@example.com"
 *   "x@y.z"              → "x***@y.z"
 *   "no-at-sign"         → "***"
 */
export function maskEmail(input: string): string {
  const at = input.indexOf('@');
  if (at < 1) return '***';
  const user = input.slice(0, at);
  const domain = input.slice(at + 1);
  if (!domain) return '***';
  return `${user[0]}***@${domain}`;
}

/**
 * Sanitize a free-text `reason` value before persistence.
 *
 *   1. Reject obviously-secret-shaped tokens (Bearer prefix, long opaque blobs).
 *   2. Mask phone numbers and email addresses found in the text.
 *   3. Truncate to MAX_REASON_LENGTH characters.
 */
export function sanitizeReason(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Refuse obviously sensitive blobs entirely rather than persist a partial.
  if (/Bearer\s+\S+/i.test(trimmed)) return '[redacted-bearer]';
  // Long opaque token shapes (no spaces, alphanum/-_).
  if (/^[A-Za-z0-9_-]{40,}$/.test(trimmed)) return '[redacted-token]';

  let masked = trimmed
    .replace(EMAIL_REGEX, m => maskEmail(m))
    .replace(PHONE_REGEX, m => maskPhone(m));

  if (masked.length > MAX_REASON_LENGTH) {
    masked = masked.slice(0, MAX_REASON_LENGTH - 1) + '…';
  }
  return masked;
}

/**
 * Allowed string lengths for the structured fields. Any field that exceeds
 * its cap is truncated rather than stored verbatim — protects the audit log
 * from being weaponized as a covert sink for large payloads.
 */
const FIELD_CAPS: Record<string, number> = {
  action: 32,
  resourceType: 64,
  resourceId: 128,
  accessType: 64,
  route: 512,
  method: 16,
  ipAddress: 64,
  userAgent: 512,
  actorRole: 32,
};

export function capField(name: keyof typeof FIELD_CAPS, value: string | null | undefined): string | null {
  if (value == null) return null;
  const max = FIELD_CAPS[name];
  if (max == null) return value;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Strip the query string from a URL/path. Query params can carry tokens
 * (`?token=...`) or PII (`?email=...`) — the path alone is enough for
 * forensic correlation.
 */
export function stripQuery(url: string | null | undefined): string | null {
  if (!url) return null;
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}
