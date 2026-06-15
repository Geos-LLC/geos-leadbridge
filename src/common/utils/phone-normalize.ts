/**
 * Phone normalization for cross-tenant comparison.
 *
 * Lead.customerPhone is stored as-is from the platform webhook — it can
 * be raw digits ("5551234567"), formatted ("(555) 123-4567"), E.164
 * ("+15551234567"), or empty. The refundable-lead duplicate detector
 * needs to compare phones across rows, so we normalize to a canonical
 * form at compare time (without rewriting any stored data).
 *
 * Returns the E.164 string ("+15551234567") for valid 10/11-digit US
 * numbers, OR null when the input has too few digits to be a real phone.
 * Callers should treat null as "incomparable" (skip the candidate).
 *
 * Mirrors src/modules/partner-network/utils/phone.util.ts so the
 * duplicate detector doesn't have to import a partner-network helper.
 * Kept intentionally permissive — we'd rather match a misformatted
 * phone than miss a duplicate due to format drift.
 */
export function normalizePhoneE164(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 11) return `+${digits}`;
  return null;
}
