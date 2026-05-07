/**
 * FAQ-context block for AI prompts.
 *
 * Emits a `--- FAQ ---` REFERENCE section that captures the per-account
 * answers to the most common customer questions (insurance, supplies,
 * pets, payment methods, scope, etc.). Without this block the AI either
 * defers everything ("the team will confirm") or fabricates plausible-
 * sounding answers — both hurt customer satisfaction.
 *
 * The shape mirrors the structured form in
 * `frontend/src/components/AccountFaqForm.tsx`. Keep them in sync.
 *
 * Empty fields are intentionally omitted from the output so the AI's
 * defer-when-empty rule (in the GLOBAL prompt) kicks in for anything
 * the tenant hasn't filled in yet.
 */

export interface AccountFaq {
  insuredAndBonded?: { value?: 'yes' | 'no' | 'unset'; details?: string };
  bringsSupplies?: { value?: 'yes' | 'no' | 'unset'; details?: string };
  petPolicy?: { value?: 'pet_friendly' | 'extra_charge' | 'no_pets' | 'unset'; details?: string };
  paymentMethods?: string[];
  customerMustBeHome?: { value?: 'no' | 'yes' | 'optional' | 'unset'; details?: string };
  sameCleanerForRecurring?: { value?: 'try' | 'guaranteed' | 'no' | 'unset'; details?: string };
  standardScope?: string;
  deepScope?: string;
  laborRatePerCleanerHour?: number;
  crewSizeRule?: { hoursThreshold?: number; sizeUnder?: number; sizeOver?: number };
  customQA?: Array<{ question?: string; answer?: string }>;
}

const PET_LABELS: Record<string, string> = {
  pet_friendly: 'Yes, pet-friendly. No extra charge.',
  extra_charge: 'Yes, but pets carry an extra charge — see pricing or defer to team for the exact amount.',
  no_pets: 'No, this account does not service homes with pets.',
};

const YES_NO_LABELS: Record<string, string> = {
  yes: 'Yes',
  no: 'No',
};

const HOME_LABELS: Record<string, string> = {
  no: 'No, the customer does not need to be home — we just need access (key code, lockbox, or in-person key handoff).',
  yes: 'Yes, the customer should be home for the cleaning.',
  optional: 'Optional — either way works. Confirm what the customer prefers.',
};

const RECURRING_LABELS: Record<string, string> = {
  try: 'We aim to send the same cleaner each visit, but cannot guarantee it.',
  guaranteed: 'Yes, the same cleaner is guaranteed for recurring visits.',
  no: 'No, recurring visits are not guaranteed to be the same cleaner.',
};

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'cash',
  check: 'check',
  venmo: 'Venmo',
  zelle: 'Zelle',
  credit_card: 'credit card',
  debit_card: 'debit card',
  invoice: 'invoice',
  paypal: 'PayPal',
};

export function parseAccountFaq(json: string | null | undefined): AccountFaq | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as AccountFaq) : null;
  } catch {
    return null;
  }
}

export function buildFaqBlock(input: AccountFaq | null | undefined): string | null {
  if (!input) return null;
  const lines: string[] = [];

  if (input.insuredAndBonded?.value && input.insuredAndBonded.value !== 'unset') {
    const label = YES_NO_LABELS[input.insuredAndBonded.value];
    const detail = input.insuredAndBonded.details?.trim();
    lines.push(`- Insured / bonded: ${label}${detail ? ` — ${detail}` : ''}`);
  }

  if (input.bringsSupplies?.value && input.bringsSupplies.value !== 'unset') {
    const label = YES_NO_LABELS[input.bringsSupplies.value];
    const detail = input.bringsSupplies.details?.trim();
    lines.push(`- Brings supplies & equipment: ${label}${detail ? ` — ${detail}` : ''}`);
  }

  if (input.petPolicy?.value && input.petPolicy.value !== 'unset') {
    const label = PET_LABELS[input.petPolicy.value];
    const detail = input.petPolicy.details?.trim();
    lines.push(`- Pet policy: ${label}${detail ? ` — ${detail}` : ''}`);
  }

  if (Array.isArray(input.paymentMethods) && input.paymentMethods.length > 0) {
    const labels = input.paymentMethods.map(m => PAYMENT_LABELS[m] || m).join(', ');
    lines.push(`- Accepted payment methods: ${labels}`);
  }

  if (input.customerMustBeHome?.value && input.customerMustBeHome.value !== 'unset') {
    const label = HOME_LABELS[input.customerMustBeHome.value];
    const detail = input.customerMustBeHome.details?.trim();
    lines.push(`- Must the customer be home? ${label}${detail ? ` — ${detail}` : ''}`);
  }

  if (input.sameCleanerForRecurring?.value && input.sameCleanerForRecurring.value !== 'unset') {
    const label = RECURRING_LABELS[input.sameCleanerForRecurring.value];
    const detail = input.sameCleanerForRecurring.details?.trim();
    lines.push(`- Same cleaner for recurring? ${label}${detail ? ` — ${detail}` : ''}`);
  }

  if (input.standardScope?.trim()) {
    lines.push(`- Standard cleaning includes: ${input.standardScope.trim()}`);
  }
  if (input.deepScope?.trim()) {
    lines.push(`- Deep cleaning includes: ${input.deepScope.trim()}`);
  }

  const labor = Number(input.laborRatePerCleanerHour);
  if (Number.isFinite(labor) && labor > 0) {
    lines.push(`- Labor rate: ~$${labor} per cleaner-hour. Total = cleaners × hours × $${labor} + extras.`);
  }

  const crew = input.crewSizeRule;
  if (crew && Number(crew.hoursThreshold) > 0) {
    const t = Number(crew.hoursThreshold);
    const u = Number(crew.sizeUnder) || 1;
    const o = Number(crew.sizeOver) || 2;
    lines.push(`- Crew sizing: send ${u} cleaner${u === 1 ? '' : 's'} for jobs up to ${t} hours, ${o} cleaners for jobs over ${t} hours. Same total price either way.`);
  }

  if (Array.isArray(input.customQA)) {
    for (const qa of input.customQA) {
      const q = qa?.question?.trim();
      const a = qa?.answer?.trim();
      if (q && a) lines.push(`- Q: ${q} — A: ${a}`);
    }
  }

  if (lines.length === 0) return null;

  return [
    '--- FAQ ---',
    'These are the verified answers for this account. When the customer asks one of these questions, use the answer below verbatim. For anything not listed here, defer ("the team will confirm") rather than fabricate.',
    ...lines,
    '--- END FAQ ---',
  ].join('\n');
}
