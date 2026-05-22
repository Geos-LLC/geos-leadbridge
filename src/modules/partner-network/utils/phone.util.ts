// Normalize a user-entered phone string to E.164 (e.g. "+15555551234").
// Returns null if the input has fewer than 10 digits — callers decide whether
// to reject or store the raw value.
//
// Kept inside the partner-network module so the whole feature stays portable:
// extracting it later means moving this folder; no shared LeadBridge utility
// has to be untangled.
export function normalizePhoneE164(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return null;
}
