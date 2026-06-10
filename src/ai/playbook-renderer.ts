/**
 * AI Playbook renderer — Stage 3.
 *
 * Pure functions, no I/O, no NestJS DI. Imported by both the backend prompt
 * assembly (automation.service.ts, follow-up-generator.service.ts) and the
 * Settings → AI Playbook page (via a parallel file at
 * frontend/src/lib/playbook-renderer.ts — keep the two in sync).
 *
 * Contract:
 *  - Behavior summary is GENERATED from existing settings (read-only in UI).
 *  - Instructions are user-editable text stored at
 *    SavedAccount.followUpSettingsJson.aiPlaybookInstructions[category].
 *  - The Playbook does NOT control behavior. Stop rules / handoff triggers /
 *    follow-up enrollment all still run as gates BEFORE the AI reply path.
 *  - Block is inserted as a new section labeled `=== PLAYBOOK ===` between
 *    PRIMARY INSTRUCTION and REFERENCE blocks in the system prompt.
 *
 * Category list locked at 8 (no new categories — these mirror existing
 * settings groups + a dedicated PRICING section for objection handling).
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

// ─── Inputs ───────────────────────────────────────────────────────────────

/** Shape the renderer needs from a SavedAccount row. Pass null/undefined freely. */
export type RawSavedAccount = {
  /** SavedAccount.aiConversationMode column — 'always' | 'when_dispatcher_unavailable'. */
  aiConversationMode: string | null;
  /** SavedAccount.followUpSettingsJson — raw JSON string (or null). */
  followUpSettingsJson: string | null;
  /** SavedAccount.servicePricingJson — raw JSON string (or null). */
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
    } catch {
      // fall through to defaults
    }
  }

  // Match Conversation.tsx / playbook-adapter defaults byte-for-byte:
  // `!== false` semantics → undefined / null / true → true.
  const boolish = (v: unknown, def: boolean): boolean => {
    if (v === undefined || v === null) return def;
    return !!v;
  };

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

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Convert "3d" → "3 days", "1w" → "1 week", "21d" → "21 days", "1h" → "1 hour". */
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
  } catch {
    return 0;
  }
}

// ─── Per-category behavior summary ────────────────────────────────────────

/**
 * Derive the bullet list shown under "Current behavior:" for a category from
 * the user's current toggle state. Pure; deterministic.
 *
 * The bullets here MIRROR the actual gates in:
 *  - automation.service.ts handleCustomerReply / maybeFireHandoffAlert
 *  - follow-up-engine enrollment paths
 *
 * If a gate changes its behavior, update the matching bullet here so the LLM
 * doesn't get a stale picture of what the backend will actually do.
 */
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
      // Hardcoded — always true regardless of toggles.
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
      // Hardcoded — Lead.status writes 'lost' with lostReason='hired_someone'
      // in automation.service.ts regardless of toggle state.
      b.push('Mark the lead as lost (reason: hired elsewhere).');
      if (s.aiHiredCompetitorReengage) {
        b.push(`Try re-engaging in ${humanizeDelay(s.aiHiredCompetitorDelay)} in case the other company doesn't work out.`);
      }
      return b;
    }
    case 'opt_out': {
      const b: string[] = [];
      if (s.aiStopOnOptOut) b.push('Stop AI when the customer asks not to be contacted.');
      // Compliance bullets — ALWAYS rendered. Per Stage 3 D2: opt-out is not
      // negotiable; the LLM must always see these even if the toggle is
      // somehow off.
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

// ─── Default per-category instructions ───────────────────────────────────

/**
 * Default instructions shipped per category. Used in two places:
 *  1. UI shows these on each Playbook card so users see what the AI is told
 *     by default, with a "Revert to default" affordance.
 *  2. The renderer falls back to these when the user has NOT customized
 *     instructions for a category — so every Playbook category contributes
 *     guidance to the prompt out-of-the-box.
 *
 * Keep these business-language, short, and safe. The LLM weighs them as
 * situational rules, NOT hard gates. Stop rules, opt-out compliance, and
 * handoff alerts still run as code-level gates before AI reply generation.
 */
export const DEFAULT_INSTRUCTIONS: Record<PlaybookCategoryKey, string> = {
  booking_requests:
    'When the customer is ready to book, acknowledge their interest first. Confirm one key detail you need (preferred date/time or service address). Let them know a team member will confirm the appointment shortly.',
  human_contact:
    'When the customer asks to speak to a person, acknowledge their request. Ask for the best time and number to reach them at. Keep the message brief and warm — don\'t try to resolve the issue in chat.',
  pricing:
    'When discussing price, lead with a clear range based on the pricing table. Note that the dispatcher confirms the exact number before booking. If the customer pushes back on price, ask what budget they had in mind before offering reduced scope. Never discount immediately.',
  customer_defers:
    'When the customer asks for more time, acknowledge it and don\'t pressure them. Confirm we\'ll reach out at the time they suggested (or our configured check-in window). Mention they can text back anytime if their timing changes.',
  hired_another:
    'When the customer says they hired another company, wish them well sincerely — no passive-aggression, no pushing for the lead. Leave the door open: "If anything doesn\'t go as expected, we\'re happy to help next time."',
  opt_out:
    'When the customer opts out, acknowledge their request politely and stop messaging. Do not ask why or try to retain them. Confirm we\'ve removed them from outreach.',
  key_details:
    'When the customer shares key details (phone, address, home size, scope), confirm what they\'ve given so they know we received it. Then ask one follow-up question to complete the picture if anything is still missing.',
  general_behavior:
    'Reply in a warm, professional tone matching the customer\'s energy. Be concise — under 3 sentences when possible. Use the business owner\'s voice (the AI represents the business, not itself). Don\'t use exclamation points except for genuine excitement (booking confirmed, etc.).',
};

/**
 * Resolves the effective instructions text for a category. User-saved
 * non-empty text wins; otherwise the shipped default is used. Whitespace-only
 * input is treated as empty.
 */
export function resolveInstructions(
  category: PlaybookCategoryKey,
  userInstructions: PlaybookInstructionsBlob,
): { text: string; isDefault: boolean } {
  const raw = userInstructions[category];
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed.length > 0) return { text: trimmed, isDefault: false };
  return { text: DEFAULT_INSTRUCTIONS[category], isDefault: true };
}

// ─── Public renderer ──────────────────────────────────────────────────────

/**
 * Build the full Playbook block injected into the system prompt.
 * Returns '' when no category has either summary bullets or instructions.
 *
 * Caller should NOT additionally wrap in a section header — this function
 * already prefixes `=== PLAYBOOK ===` when non-empty.
 */
export function renderPlaybookBlock(savedAccount: RawSavedAccount): string {
  const settings = parseFollowUpSettings(savedAccount.followUpSettingsJson);
  const pricingRowCount = countPricingRows(savedAccount.servicePricingJson);
  const instructions = settings.instructions;

  const sections: string[] = [];
  for (const category of CATEGORY_ORDER) {
    const summaryBullets = renderBehaviorSummary(category, settings, savedAccount.aiConversationMode, pricingRowCount);
    // Resolved instructions = user custom if set, else shipped default. Every
    // category contributes Instructions text to the prompt — users opt OUT
    // by clicking "Revert to default" in the UI (which clears their custom
    // text and falls back here to the shipped default).
    const { text: userText } = resolveInstructions(category, instructions);
    if (summaryBullets.length === 0 && !userText) continue;
    const parts: string[] = [`[${CATEGORY_DISPLAY_LABELS[category]}]`];
    if (summaryBullets.length > 0) {
      parts.push('Current behavior:', ...summaryBullets.map(b => `* ${b}`));
    }
    if (userText) {
      parts.push('Instructions:', userText);
    }
    sections.push(parts.join('\n'));
  }

  if (sections.length === 0) return '';
  return '=== PLAYBOOK ===\n' + sections.join('\n\n');
}

// ─── Frontend preview helper ──────────────────────────────────────────────

export type PerCategoryPreview = {
  category: PlaybookCategoryKey;
  label: string;
  behaviorBullets: string[];
  /** User's saved text, or '' when none. The UI uses this to decide whether to show "Revert to default". */
  customInstructions: string;
  /** The shipped default for this category (always non-empty). UI surfaces this so users know what AI sees by default. */
  defaultInstructions: string;
};

/**
 * Returns the structured per-category data the Settings page renders for the
 * user. Same derivation as `renderPlaybookBlock` but without the prompt-text
 * assembly, so the UI can format each section however it wants.
 */
export function previewPlaybookCategories(savedAccount: RawSavedAccount): PerCategoryPreview[] {
  const settings = parseFollowUpSettings(savedAccount.followUpSettingsJson);
  const pricingRowCount = countPricingRows(savedAccount.servicePricingJson);
  return CATEGORY_ORDER.map(category => {
    const raw = settings.instructions[category];
    const customInstructions = typeof raw === 'string' ? raw.trim() : '';
    return {
      category,
      label: CATEGORY_DISPLAY_LABELS[category],
      behaviorBullets: renderBehaviorSummary(category, settings, savedAccount.aiConversationMode, pricingRowCount),
      customInstructions,
      defaultInstructions: DEFAULT_INSTRUCTIONS[category],
    };
  });
}
