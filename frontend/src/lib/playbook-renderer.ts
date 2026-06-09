/**
 * Frontend mirror of `src/ai/playbook-renderer.ts` — Stage 3.
 *
 * Same derivation logic, used only for the live preview in the
 * Settings → AI Playbook page. Backend remains the source of truth for what
 * lands in the actual system prompt at reply time; this mirror exists so the
 * user can see what behavior summary they'll get without a network round-trip.
 *
 * Keep this file in sync with src/ai/playbook-renderer.ts. The full
 * renderPlaybookBlock + previewPlaybookCategories pair has 37 Jest scenarios
 * in playbook-renderer.spec.ts — when changing derivation rules, edit both
 * files and rerun Jest.
 */

export type PlaybookCategoryKey =
  | 'booking_requests'
  | 'human_contact'
  | 'pricing'
  | 'customer_defers'
  | 'hired_another'
  | 'opt_out'
  | 'key_details'
  | 'general_behavior';

export type PlaybookInstructionsBlob = {
  [K in PlaybookCategoryKey]?: string;
};

export const CATEGORY_ORDER: readonly PlaybookCategoryKey[] = [
  'booking_requests',
  'human_contact',
  'pricing',
  'customer_defers',
  'hired_another',
  'opt_out',
  'key_details',
  'general_behavior',
] as const;

export const CATEGORY_DISPLAY_LABELS: Record<PlaybookCategoryKey, string> = {
  booking_requests: 'BOOKING REQUESTS',
  human_contact:    'HUMAN CONTACT REQUESTS',
  pricing:          'PRICING',
  customer_defers:  'CUSTOMER DEFERS',
  hired_another:    'HIRED ANOTHER COMPANY',
  opt_out:          'OPT-OUT',
  key_details:      'KEY DETAILS COLLECTED',
  general_behavior: 'GENERAL AI BEHAVIOR',
};

// User-friendly labels for the UI page (lowercase, prose) — separate from the
// CAPS labels we send to the LLM in the prompt block.
export const CATEGORY_UI_LABELS: Record<PlaybookCategoryKey, string> = {
  booking_requests: 'Booking requests',
  human_contact:    'Human contact requests',
  pricing:          'Pricing',
  customer_defers:  'Customer defers',
  hired_another:    'Hired another company',
  opt_out:          'Opt-out / do not contact',
  key_details:      'Key details collected',
  general_behavior: 'General AI behavior',
};

export type RawSavedAccount = {
  aiConversationMode: string | null;
  followUpSettingsJson: string | null;
  servicePricingJson: string | null;
};

type WritingStyle = 'auto' | 'hybrid' | 'price' | 'qualify' | 'convert' | 'phone';
type PriceQuoteMode = 'range' | 'exact';

type ParsedSettings = {
  followUpStrategy: WritingStyle;
  priceQuoteMode: PriceQuoteMode;
  aiStopOnOptOut: boolean;
  aiStopOnBooked: boolean;
  aiStopOnPriceAgreed: boolean;
  handoffTriggerAgreed: boolean;
  handoffTriggerWantsLiveContact: boolean;
  handoffTriggerProvidedPhone: boolean;
  handoffTriggerProvidedSquareFootage: boolean;
  handoffTriggerQualificationComplete: boolean;
  aiDeferralCheckIn: boolean;
  aiDeferralDelay: string;
  aiHiredCompetitorReengage: boolean;
  aiHiredCompetitorDelay: string;
  instructions: PlaybookInstructionsBlob;
};

const VALID_STYLES: WritingStyle[] = ['auto', 'hybrid', 'price', 'qualify', 'convert', 'phone'];

function parseFollowUpSettings(raw: string | null): ParsedSettings {
  let s: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') s = parsed as Record<string, unknown>;
    } catch { /* defaults */ }
  }
  const boolish = (v: unknown, def: boolean): boolean => (v === undefined || v === null ? def : !!v);

  const followUpStrategy: WritingStyle =
    typeof s.followUpStrategy === 'string' && (VALID_STYLES as string[]).includes(s.followUpStrategy)
      ? (s.followUpStrategy as WritingStyle)
      : 'auto';

  const instructions: PlaybookInstructionsBlob =
    s.aiPlaybookInstructions && typeof s.aiPlaybookInstructions === 'object' && !Array.isArray(s.aiPlaybookInstructions)
      ? (s.aiPlaybookInstructions as PlaybookInstructionsBlob)
      : {};

  return {
    followUpStrategy,
    priceQuoteMode: s.priceQuoteMode === 'exact' ? 'exact' : 'range',
    aiStopOnOptOut:                      boolish(s.aiStopOnOptOut, true),
    aiStopOnBooked:                      boolish(s.aiStopOnBooked, true),
    aiStopOnPriceAgreed:                 boolish(s.aiStopOnPriceAgreed, true),
    handoffTriggerAgreed:                boolish(s.handoffTriggerAgreed, true),
    handoffTriggerWantsLiveContact:      boolish(s.handoffTriggerWantsLiveContact, true),
    handoffTriggerProvidedPhone:         boolish(s.handoffTriggerProvidedPhone, true),
    handoffTriggerProvidedSquareFootage: boolish(s.handoffTriggerProvidedSquareFootage, true),
    handoffTriggerQualificationComplete: boolish(s.handoffTriggerQualificationComplete, true),
    aiDeferralCheckIn:                   boolish(s.aiDeferralCheckIn, true),
    aiDeferralDelay:                     typeof s.aiDeferralDelay === 'string' ? s.aiDeferralDelay : '3d',
    aiHiredCompetitorReengage:           boolish(s.aiHiredCompetitorReengage, true),
    aiHiredCompetitorDelay:              typeof s.aiHiredCompetitorDelay === 'string' ? s.aiHiredCompetitorDelay : '21d',
    instructions,
  };
}

export function humanizeDelay(delay: string): string {
  const m = /^(\d+)([hdw])$/.exec(delay.trim());
  if (!m) return delay;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  if (unit === 'h') return n === 1 ? '1 hour' : `${n} hours`;
  if (unit === 'd') return n === 1 ? '1 day' : `${n} days`;
  if (unit === 'w') return n === 1 ? '1 week' : `${n} weeks`;
  return delay;
}

function countPricingRows(servicePricingJson: string | null): number {
  if (!servicePricingJson) return 0;
  try {
    const p = JSON.parse(servicePricingJson) as { priceTable?: unknown[] };
    return Array.isArray(p?.priceTable) ? p.priceTable.length : 0;
  } catch { return 0; }
}

function renderBehaviorSummary(
  category: PlaybookCategoryKey,
  s: ParsedSettings,
  aiConversationMode: string | null,
  pricingRowCount: number,
): string[] {
  switch (category) {
    case 'booking_requests': {
      const b: string[] = [];
      if (s.handoffTriggerAgreed) b.push('Notify the team when the customer is ready to book.');
      if (s.aiStopOnPriceAgreed)  b.push('Pause AI when the customer agrees on price or asks to book.');
      if (s.aiStopOnBooked)       b.push('Stop AI when the job is booked or confirmed.');
      return b;
    }
    case 'human_contact': {
      const b: string[] = [];
      if (s.handoffTriggerWantsLiveContact) b.push('Notify the team when the customer asks to speak to a person.');
      if (s.aiStopOnPriceAgreed)            b.push('Pause AI when the customer asks for a person.');
      return b;
    }
    case 'pricing': {
      const b: string[] = [];
      if (s.followUpStrategy === 'price') {
        b.push('Lead with a price range proactively.');
      } else if (s.followUpStrategy === 'qualify') {
        b.push('Never volunteer a price — qualify the lead first.');
      } else {
        b.push('Only quote a price when the customer asks about it.');
      }
      b.push(s.priceQuoteMode === 'exact'
        ? 'Quote an exact price when the pricing table has enough information.'
        : 'Quote a price range; dispatcher confirms the exact number.');
      b.push('Dispatcher confirms final pricing before booking is locked.');
      b.push(pricingRowCount > 0
        ? `Pricing table has ${pricingRowCount} configured size/scope combinations.`
        : 'No pricing table configured — AI cannot quote concrete numbers.');
      return b;
    }
    case 'customer_defers': {
      const b: string[] = [];
      if (s.aiDeferralCheckIn) {
        b.push(`Pause AI and check in again in ${humanizeDelay(s.aiDeferralDelay)}.`);
        b.push('Send a re-engagement message at that time.');
      }
      return b;
    }
    case 'hired_another': {
      const b: string[] = [];
      if (s.aiStopOnBooked) b.push('Stop AI when the customer says they hired another company.');
      b.push('Mark the lead as lost (reason: hired elsewhere).');
      if (s.aiHiredCompetitorReengage) {
        b.push(`Try re-engaging in ${humanizeDelay(s.aiHiredCompetitorDelay)} in case the other company doesn't work out.`);
      }
      return b;
    }
    case 'opt_out': {
      const b: string[] = [];
      if (s.aiStopOnOptOut) b.push('Stop AI when the customer asks not to be contacted.');
      b.push('Mark the lead as lost (reason: opt-out).');
      b.push('Do not contact again.');
      return b;
    }
    case 'key_details': {
      const b: string[] = [];
      if (s.handoffTriggerProvidedPhone)         b.push('Notify the team when the customer shares a phone number.');
      if (s.handoffTriggerProvidedSquareFootage) b.push('Notify the team when the customer shares the home size (sqft).');
      if (s.handoffTriggerQualificationComplete) b.push('Notify the team when enough details are collected to quote.');
      return b;
    }
    case 'general_behavior': {
      const styleLabels: Record<WritingStyle, string> = {
        auto:    'AI picks the best approach for each reply',
        hybrid:  'balance qualifying questions, converting, and pricing',
        price:   'lead with a price range proactively',
        qualify: 'ask qualifying questions; never volunteer price',
        convert: 'push toward booking and ask for a preferred time',
        phone:   'encourage a phone call with the team',
      };
      const availability = aiConversationMode === 'always'
        ? 'Reply at any time of day.'
        : 'Reply only outside business hours; humans handle daytime.';
      return [
        `Writing style: ${styleLabels[s.followUpStrategy]}.`,
        availability,
      ];
    }
  }
}

export type PerCategoryPreview = {
  category: PlaybookCategoryKey;
  promptLabel: string;
  uiLabel: string;
  behaviorBullets: string[];
  instructions: string;
};

export function previewPlaybookCategories(savedAccount: RawSavedAccount): PerCategoryPreview[] {
  const settings = parseFollowUpSettings(savedAccount.followUpSettingsJson);
  const pricingRowCount = countPricingRows(savedAccount.servicePricingJson);
  return CATEGORY_ORDER.map(category => {
    const raw = settings.instructions[category];
    const instructions = typeof raw === 'string' ? raw.trim() : '';
    return {
      category,
      promptLabel: CATEGORY_DISPLAY_LABELS[category],
      uiLabel: CATEGORY_UI_LABELS[category],
      behaviorBullets: renderBehaviorSummary(category, settings, savedAccount.aiConversationMode, pricingRowCount),
      instructions,
    };
  });
}

/** Threshold values for the soft length warning on the editor. */
export const INSTRUCTION_LENGTH_SOFT = 3000;
export const INSTRUCTION_LENGTH_WARN = 5000;
