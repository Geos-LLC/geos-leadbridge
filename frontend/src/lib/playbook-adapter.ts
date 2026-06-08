/**
 * Playbook Adapter — Phase 2 (UI presentation layer)
 *
 * Single boundary between the new AI Playbook UI and the existing
 * SavedAccount settings storage. Pure functions, no I/O.
 *
 * The Playbook UI calls buildPlaybookView() to render and savePlaybookView()
 * to commit. The adapter maps Playbook concepts to the same
 * followUpSettingsJson keys and saved_accounts columns the existing AI
 * Conversation page (Conversation.tsx) already reads/writes — so a Playbook
 * write is indistinguishable from a Conversation.tsx write at the storage
 * layer. No backend changes. No behavior changes.
 *
 * Phase 2 contract (locked):
 *   - Decision #1 Option B: "When AI replies" reads/writes ONLY
 *     SavedAccount.aiConversationMode (column). followUpAvailability is
 *     deliberately NOT touched — it stays in the follow-up engine's domain
 *     and is managed from Services.tsx.
 *   - Decision #6: aiStopOnPriceAgreed remains a single key. Playbook
 *     exposes it twice (bookingRequests.pauseAi + humanContact.pauseAi)
 *     so the UI contract stays stable when Phase 4+ splits the backend.
 *   - All defaults must match Conversation.tsx byte-for-byte.
 *   - Partial writes: savePlaybookView returns only the keys present in
 *     the input, mirroring Conversation.tsx's dirty-field pattern.
 *
 * Test scenarios are documented in playbook-adapter.test.ts as a
 * runVerification() function. Frontend has no test runner installed
 * (Phase 5+ adds Vitest). Run manually by importing runVerification()
 * from a dev-only entry point.
 */

export type WritingStyle = 'auto' | 'hybrid' | 'price' | 'qualify' | 'convert' | 'phone';
export type PriceQuoteMode = 'range' | 'exact';
export type WhenAiReplies = 'always' | 'hours';
export type AiBehaviorMode = 'off' | 'suggest' | 'auto_send';

export type PlaybookView = {
  global: {
    /** Read-only display sourced from User.aiConversationEnabled. Not writable from Playbook. */
    aiEnabled: boolean;
    /** Read-only display sourced from SavedAccount.followUpMode. Managed elsewhere. */
    mode: AiBehaviorMode | null;
    /** Writes to SavedAccount.aiConversationMode column ONLY (Decision #1 Option B). */
    whenAiReplies: WhenAiReplies;
    writingStyle: WritingStyle;
    priceQuoteMode: PriceQuoteMode;
  };
  cards: {
    bookingRequests: {
      notifyTeam: boolean;       // handoffTriggerAgreed
      pauseAi: boolean;          // aiStopOnPriceAgreed (shared key — see humanContact.pauseAi)
      stopOnBooked: boolean;     // aiStopOnBooked
    };
    humanContact: {
      notifyTeam: boolean;       // handoffTriggerWantsLiveContact
      pauseAi: boolean;          // SAME aiStopOnPriceAgreed key as bookingRequests.pauseAi
    };
    customerDefers: {
      enabled: boolean;          // aiDeferralCheckIn
      delay: string;             // aiDeferralDelay
      message: string;           // aiDeferralMessage
    };
    hiredAnother: {
      enabled: boolean;          // aiHiredCompetitorReengage
      delay: string;             // aiHiredCompetitorDelay
      message: string;           // aiHiredCompetitorMessage
    };
    optOut: {
      stopAi: boolean;           // aiStopOnOptOut
    };
    keyDetails: {
      notifyOnPhone: boolean;    // handoffTriggerProvidedPhone
      notifyOnSqft: boolean;     // handoffTriggerProvidedSquareFootage
      notifyOnQualified: boolean;// handoffTriggerQualificationComplete
    };
  };
};

export type SavedAccountSnapshot = {
  id: string;
  followUpMode: string | null;
  aiConversationMode: string | null;
  followUpSettingsJson: string | null;
};

export type UserSnapshot = {
  aiConversationEnabled: boolean;
};

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export type PlaybookPatches = {
  /** Goes to followUpApi.saveWizardSettings(accountId, settingsPatch). */
  settingsPatch: Record<string, unknown>;
  /** Goes to usersApi.updateAccountHours(accountId, columnPatch). */
  columnPatch: { aiConversationMode?: 'always' | 'when_dispatcher_unavailable' };
};

// ─── Defaults ─────────────────────────────────────────────────────────────
// Must match Conversation.tsx exactly. Changing these is a behavior change
// for accounts whose followUpSettingsJson is null/missing. Sourced from:
//   - Conversation.tsx parseSettings (line 101-120)
//   - Services.tsx initial state (lines 520-526)
//   - schema.prisma SavedAccount.aiConversationMode @default("when_dispatcher_unavailable")

const DEFAULT_DEFERRAL_MESSAGE =
  "Hi {{lead.name}}, just circling back — did you get a chance to think it over? " +
  "Happy to answer any questions or help get you on the schedule if you're ready.";

const DEFAULT_HIRED_MESSAGE =
  "Hi {{lead.name}}, hope your cleaning went well! If anything didn't go the way you " +
  "hoped, we'd be happy to help next time. No pressure either way.";

const VALID_WRITING_STYLES: WritingStyle[] = ['auto', 'hybrid', 'price', 'qualify', 'convert', 'phone'];

// ─── Helpers ──────────────────────────────────────────────────────────────

function parseSettingsJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Matches Conversation.tsx's `s.foo !== undefined ? !!s.foo : defaultTrue` pattern. */
function boolish(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  return !!value;
}

function pickWritingStyle(value: unknown): WritingStyle {
  if (typeof value !== 'string') return 'auto';
  return (VALID_WRITING_STYLES as string[]).includes(value) ? (value as WritingStyle) : 'auto';
}

// ─── Read ─────────────────────────────────────────────────────────────────

export function buildPlaybookView(args: {
  savedAccount: SavedAccountSnapshot;
  user: UserSnapshot;
}): PlaybookView {
  const s = parseSettingsJson(args.savedAccount.followUpSettingsJson);

  // Decision #1 Option B: column-only. We do NOT fall back to
  // followUpAvailability. Null column → schema default
  // "when_dispatcher_unavailable" → 'hours'.
  const colMode = args.savedAccount.aiConversationMode;
  const whenAiReplies: WhenAiReplies = colMode === 'always' ? 'always' : 'hours';

  const stopPriceAgreed = boolish(s.aiStopOnPriceAgreed, true);

  return {
    global: {
      aiEnabled: args.user.aiConversationEnabled,
      mode: (args.savedAccount.followUpMode ?? null) as AiBehaviorMode | null,
      whenAiReplies,
      writingStyle: pickWritingStyle(s.followUpStrategy),
      priceQuoteMode: s.priceQuoteMode === 'exact' ? 'exact' : 'range',
    },
    cards: {
      bookingRequests: {
        notifyTeam:   boolish(s.handoffTriggerAgreed, true),
        pauseAi:      stopPriceAgreed,
        stopOnBooked: boolish(s.aiStopOnBooked, true),
      },
      humanContact: {
        notifyTeam: boolish(s.handoffTriggerWantsLiveContact, true),
        pauseAi:    stopPriceAgreed, // mirror of bookingRequests.pauseAi
      },
      customerDefers: {
        enabled: boolish(s.aiDeferralCheckIn, true),
        delay:   typeof s.aiDeferralDelay   === 'string' ? s.aiDeferralDelay   : '3d',
        message: typeof s.aiDeferralMessage === 'string' ? s.aiDeferralMessage : DEFAULT_DEFERRAL_MESSAGE,
      },
      hiredAnother: {
        enabled: boolish(s.aiHiredCompetitorReengage, true),
        delay:   typeof s.aiHiredCompetitorDelay   === 'string' ? s.aiHiredCompetitorDelay   : '21d',
        message: typeof s.aiHiredCompetitorMessage === 'string' ? s.aiHiredCompetitorMessage : DEFAULT_HIRED_MESSAGE,
      },
      optOut: {
        stopAi: boolish(s.aiStopOnOptOut, true),
      },
      keyDetails: {
        notifyOnPhone:     boolish(s.handoffTriggerProvidedPhone, true),
        notifyOnSqft:      boolish(s.handoffTriggerProvidedSquareFootage, true),
        notifyOnQualified: boolish(s.handoffTriggerQualificationComplete, true),
      },
    },
  };
}

// ─── Write ────────────────────────────────────────────────────────────────

/**
 * Convert a partial PlaybookView (only the fields the user touched) into
 * two patches that get sent to the existing endpoints. Keys NOT present in
 * the input are NOT in the output — this preserves Conversation.tsx's
 * dirty-field semantics so untouched values are never overwritten.
 */
export function savePlaybookView(partial: DeepPartial<PlaybookView>): PlaybookPatches {
  const settingsPatch: Record<string, unknown> = {};
  const columnPatch: PlaybookPatches['columnPatch'] = {};

  const g = partial.global;
  if (g) {
    if (g.whenAiReplies !== undefined) {
      columnPatch.aiConversationMode = g.whenAiReplies === 'always' ? 'always' : 'when_dispatcher_unavailable';
    }
    if (g.writingStyle   !== undefined) settingsPatch.followUpStrategy = g.writingStyle;
    if (g.priceQuoteMode !== undefined) settingsPatch.priceQuoteMode   = g.priceQuoteMode;
    // global.aiEnabled and global.mode are NOT writable from the Playbook
    // — see PlaybookView jsdoc.
  }

  const c = partial.cards;
  if (c) {
    if (c.bookingRequests) {
      const b = c.bookingRequests;
      if (b.notifyTeam   !== undefined) settingsPatch.handoffTriggerAgreed = b.notifyTeam;
      if (b.stopOnBooked !== undefined) settingsPatch.aiStopOnBooked       = b.stopOnBooked;
      if (b.pauseAi      !== undefined) settingsPatch.aiStopOnPriceAgreed  = b.pauseAi;
    }
    if (c.humanContact) {
      const h = c.humanContact;
      if (h.notifyTeam !== undefined) settingsPatch.handoffTriggerWantsLiveContact = h.notifyTeam;
      // Mirrored write to the same legacy key. If both bookingRequests.pauseAi
      // and humanContact.pauseAi are present in the patch, the last assignment
      // wins (insertion order). UI prevents that by mirroring state at render
      // time, so a toggle on either card sends only one value.
      if (h.pauseAi !== undefined) settingsPatch.aiStopOnPriceAgreed = h.pauseAi;
    }
    if (c.customerDefers) {
      const d = c.customerDefers;
      if (d.enabled !== undefined) settingsPatch.aiDeferralCheckIn = d.enabled;
      if (d.delay   !== undefined) settingsPatch.aiDeferralDelay   = d.delay;
      if (d.message !== undefined) settingsPatch.aiDeferralMessage = d.message;
    }
    if (c.hiredAnother) {
      const ha = c.hiredAnother;
      if (ha.enabled !== undefined) settingsPatch.aiHiredCompetitorReengage = ha.enabled;
      if (ha.delay   !== undefined) settingsPatch.aiHiredCompetitorDelay    = ha.delay;
      if (ha.message !== undefined) settingsPatch.aiHiredCompetitorMessage  = ha.message;
    }
    if (c.optOut) {
      if (c.optOut.stopAi !== undefined) settingsPatch.aiStopOnOptOut = c.optOut.stopAi;
    }
    if (c.keyDetails) {
      const k = c.keyDetails;
      if (k.notifyOnPhone     !== undefined) settingsPatch.handoffTriggerProvidedPhone         = k.notifyOnPhone;
      if (k.notifyOnSqft      !== undefined) settingsPatch.handoffTriggerProvidedSquareFootage = k.notifyOnSqft;
      if (k.notifyOnQualified !== undefined) settingsPatch.handoffTriggerQualificationComplete = k.notifyOnQualified;
    }
  }

  return { settingsPatch, columnPatch };
}
