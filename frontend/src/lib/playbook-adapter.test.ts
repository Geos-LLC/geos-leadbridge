/**
 * Playbook adapter verification — Phase 2.
 *
 * The frontend has no test runner installed; this file holds the 10 contract
 * scenarios from the Phase 2 PR plan as a runnable function. It can be
 * invoked from a dev-only entry point (e.g. a `window.__verifyPlaybook()`
 * shim during local development) and will throw on the first failing
 * scenario. When a test runner is added in a later phase, promote each
 * `runScenarioN()` to an `it(...)` block.
 *
 * To run manually in dev:
 *   import { runVerification } from './lib/playbook-adapter.test';
 *   runVerification(); // throws on failure, returns count of passes
 */

import {
  buildPlaybookView,
  savePlaybookView,
  type PlaybookView,
  type SavedAccountSnapshot,
  type UserSnapshot,
} from './playbook-adapter';

function assert(cond: unknown, label: string): void {
  if (!cond) throw new Error(`Playbook adapter scenario FAILED: ${label}`);
}
function assertEq<T>(actual: T, expected: T, label: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Playbook adapter scenario FAILED: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

const emptyUser: UserSnapshot = { aiConversationEnabled: true };
const emptyAccount: SavedAccountSnapshot = {
  id: 'acct-1',
  followUpMode: 'auto_send',
  aiConversationMode: 'when_dispatcher_unavailable',
  followUpSettingsJson: null,
};

// ─── SCENARIO 1 ───────────────────────────────────────────────────────────
// Round-trip: a populated SavedAccount produces a view that, when passed
// back through savePlaybookView, yields a settingsPatch whose values match
// the original JSON for every Playbook-relevant key.
function runScenario1_RoundTrip(): void {
  const settingsJson = JSON.stringify({
    followUpStrategy: 'qualify',
    priceQuoteMode: 'exact',
    aiStopOnOptOut: false,
    aiStopOnBooked: false,
    aiStopOnPriceAgreed: false,
    handoffTriggerAgreed: false,
    handoffTriggerWantsLiveContact: false,
    handoffTriggerProvidedPhone: false,
    handoffTriggerProvidedSquareFootage: false,
    handoffTriggerQualificationComplete: false,
    aiDeferralCheckIn: false,
    aiDeferralDelay: '7d',
    aiDeferralMessage: 'custom defer',
    aiHiredCompetitorReengage: false,
    aiHiredCompetitorDelay: '30d',
    aiHiredCompetitorMessage: 'custom hired',
  });
  const view = buildPlaybookView({
    savedAccount: { ...emptyAccount, aiConversationMode: 'always', followUpSettingsJson: settingsJson },
    user: emptyUser,
  });

  const { settingsPatch, columnPatch } = savePlaybookView(view);

  assertEq(settingsPatch.followUpStrategy, 'qualify', 'S1 followUpStrategy');
  assertEq(settingsPatch.priceQuoteMode, 'exact', 'S1 priceQuoteMode');
  assertEq(settingsPatch.aiStopOnOptOut, false, 'S1 aiStopOnOptOut');
  assertEq(settingsPatch.aiStopOnBooked, false, 'S1 aiStopOnBooked');
  assertEq(settingsPatch.aiStopOnPriceAgreed, false, 'S1 aiStopOnPriceAgreed');
  assertEq(settingsPatch.handoffTriggerAgreed, false, 'S1 handoffTriggerAgreed');
  assertEq(settingsPatch.handoffTriggerWantsLiveContact, false, 'S1 handoffTriggerWantsLiveContact');
  assertEq(settingsPatch.handoffTriggerProvidedPhone, false, 'S1 handoffTriggerProvidedPhone');
  assertEq(settingsPatch.handoffTriggerProvidedSquareFootage, false, 'S1 handoffTriggerProvidedSquareFootage');
  assertEq(settingsPatch.handoffTriggerQualificationComplete, false, 'S1 handoffTriggerQualificationComplete');
  assertEq(settingsPatch.aiDeferralCheckIn, false, 'S1 aiDeferralCheckIn');
  assertEq(settingsPatch.aiDeferralDelay, '7d', 'S1 aiDeferralDelay');
  assertEq(settingsPatch.aiDeferralMessage, 'custom defer', 'S1 aiDeferralMessage');
  assertEq(settingsPatch.aiHiredCompetitorReengage, false, 'S1 aiHiredCompetitorReengage');
  assertEq(settingsPatch.aiHiredCompetitorDelay, '30d', 'S1 aiHiredCompetitorDelay');
  assertEq(settingsPatch.aiHiredCompetitorMessage, 'custom hired', 'S1 aiHiredCompetitorMessage');
  assertEq(columnPatch.aiConversationMode, 'always', 'S1 aiConversationMode column');
}

// ─── SCENARIO 2 ───────────────────────────────────────────────────────────
// Empty followUpSettingsJson + null column → every default matches
// Conversation.tsx (all toggles default ON, strategy='auto', priceMode='range',
// availability='hours' because aiConversationMode null → schema default
// "when_dispatcher_unavailable").
function runScenario2_Defaults(): void {
  const view = buildPlaybookView({
    savedAccount: { ...emptyAccount, aiConversationMode: null, followUpSettingsJson: null },
    user: emptyUser,
  });
  assertEq(view.global.writingStyle, 'auto', 'S2 writingStyle default');
  assertEq(view.global.priceQuoteMode, 'range', 'S2 priceQuoteMode default');
  assertEq(view.global.whenAiReplies, 'hours', 'S2 whenAiReplies default (null column)');
  assertEq(view.cards.bookingRequests.notifyTeam, true, 'S2 bookingRequests.notifyTeam default');
  assertEq(view.cards.bookingRequests.pauseAi, true, 'S2 bookingRequests.pauseAi default');
  assertEq(view.cards.bookingRequests.stopOnBooked, true, 'S2 bookingRequests.stopOnBooked default');
  assertEq(view.cards.humanContact.notifyTeam, true, 'S2 humanContact.notifyTeam default');
  assertEq(view.cards.humanContact.pauseAi, true, 'S2 humanContact.pauseAi default');
  assertEq(view.cards.customerDefers.enabled, true, 'S2 customerDefers.enabled default');
  assertEq(view.cards.customerDefers.delay, '3d', 'S2 customerDefers.delay default');
  assert(view.cards.customerDefers.message.startsWith('Hi {{lead.name}}'), 'S2 customerDefers.message default');
  assertEq(view.cards.hiredAnother.enabled, true, 'S2 hiredAnother.enabled default');
  assertEq(view.cards.hiredAnother.delay, '21d', 'S2 hiredAnother.delay default');
  assert(view.cards.hiredAnother.message.startsWith('Hi {{lead.name}}'), 'S2 hiredAnother.message default');
  assertEq(view.cards.optOut.stopAi, true, 'S2 optOut.stopAi default');
  assertEq(view.cards.keyDetails.notifyOnPhone, true, 'S2 keyDetails.notifyOnPhone default');
  assertEq(view.cards.keyDetails.notifyOnSqft, true, 'S2 keyDetails.notifyOnSqft default');
  assertEq(view.cards.keyDetails.notifyOnQualified, true, 'S2 keyDetails.notifyOnQualified default');
}

// ─── SCENARIO 3 ───────────────────────────────────────────────────────────
// Partial save — flipping only cards.optOut.stopAi writes ONE key.
function runScenario3_PartialOptOut(): void {
  const { settingsPatch, columnPatch } = savePlaybookView({
    cards: { optOut: { stopAi: false } },
  });
  assertEq(Object.keys(settingsPatch).length, 1, 'S3 single settingsPatch key');
  assertEq(settingsPatch.aiStopOnOptOut, false, 'S3 aiStopOnOptOut value');
  assertEq(Object.keys(columnPatch).length, 0, 'S3 no column writes');
}

// ─── SCENARIO 4 ───────────────────────────────────────────────────────────
// Partial save — flipping only global.whenAiReplies writes the column ONLY.
function runScenario4_PartialWhenAiReplies(): void {
  const { settingsPatch, columnPatch } = savePlaybookView({
    global: { whenAiReplies: 'always' },
  });
  assertEq(Object.keys(settingsPatch).length, 0, 'S4 no settings writes');
  assertEq(columnPatch.aiConversationMode, 'always', 'S4 column written');

  const { settingsPatch: sp2, columnPatch: cp2 } = savePlaybookView({
    global: { whenAiReplies: 'hours' },
  });
  assertEq(Object.keys(sp2).length, 0, 'S4 hours: no settings writes');
  assertEq(cp2.aiConversationMode, 'when_dispatcher_unavailable', 'S4 hours: column = when_dispatcher_unavailable');
}

// ─── SCENARIO 5 ───────────────────────────────────────────────────────────
// Mirrored write FROM bookingRequests.pauseAi=false → single shared key.
function runScenario5_MirrorWriteBooking(): void {
  const { settingsPatch } = savePlaybookView({
    cards: { bookingRequests: { pauseAi: false } },
  });
  assertEq(settingsPatch.aiStopOnPriceAgreed, false, 'S5 mirror booking → aiStopOnPriceAgreed');
  assertEq(Object.keys(settingsPatch).length, 1, 'S5 exactly one key written');
}

// ─── SCENARIO 6 ───────────────────────────────────────────────────────────
// Mirrored write FROM humanContact.pauseAi=false → same single shared key.
function runScenario6_MirrorWriteHuman(): void {
  const { settingsPatch } = savePlaybookView({
    cards: { humanContact: { pauseAi: false } },
  });
  assertEq(settingsPatch.aiStopOnPriceAgreed, false, 'S6 mirror human → aiStopOnPriceAgreed');
  assertEq(Object.keys(settingsPatch).length, 1, 'S6 exactly one key written');
}

// ─── SCENARIO 7 ───────────────────────────────────────────────────────────
// Mirrored read — JSON {aiStopOnPriceAgreed:false} → both view fields false.
function runScenario7_MirrorRead(): void {
  const view = buildPlaybookView({
    savedAccount: {
      ...emptyAccount,
      followUpSettingsJson: JSON.stringify({ aiStopOnPriceAgreed: false }),
    },
    user: emptyUser,
  });
  assertEq(view.cards.bookingRequests.pauseAi, false, 'S7 booking.pauseAi from shared key');
  assertEq(view.cards.humanContact.pauseAi, false, 'S7 humanContact.pauseAi from shared key');
}

// ─── SCENARIO 8 ───────────────────────────────────────────────────────────
// Decision #1 Option B — column='always' conflicting with
// JSON.followUpAvailability='active_hours'. Column wins. JSON key ignored.
function runScenario8_DecisionOneOptionB(): void {
  const view = buildPlaybookView({
    savedAccount: {
      ...emptyAccount,
      aiConversationMode: 'always',
      followUpSettingsJson: JSON.stringify({ followUpAvailability: 'active_hours' }),
    },
    user: emptyUser,
  });
  assertEq(view.global.whenAiReplies, 'always', 'S8 column wins over followUpAvailability JSON key');
}

// ─── SCENARIO 9 ───────────────────────────────────────────────────────────
// Column patch shape matches usersApi.updateAccountHours DTO — values are
// exactly 'always' | 'when_dispatcher_unavailable' (the only two the
// backend's validateAccountHours accepts in users.service.ts:378).
function runScenario9_ColumnDtoShape(): void {
  const { columnPatch: cp1 } = savePlaybookView({ global: { whenAiReplies: 'always' } });
  assert(cp1.aiConversationMode === 'always', 'S9 always literal');
  const { columnPatch: cp2 } = savePlaybookView({ global: { whenAiReplies: 'hours' } });
  assert(cp2.aiConversationMode === 'when_dispatcher_unavailable', 'S9 when_dispatcher_unavailable literal');
}

// ─── SCENARIO 10 ──────────────────────────────────────────────────────────
// Every key Conversation.tsx writes via saveWizardSettings must be reachable
// through savePlaybookView. This is the regression contract: if Conversation
// is replaced tomorrow, Playbook covers the same surface area. Note that
// followUpAvailability is INTENTIONALLY excluded — Decision #1 Option B.
function runScenario10_ConversationKeyCoverage(): void {
  // Synthesize a full PlaybookView with every field flipped from defaults
  // so each maps to a distinct payload key.
  const view: DeepPartialAll<PlaybookView> = {
    global: {
      whenAiReplies: 'always',
      writingStyle: 'qualify',
      priceQuoteMode: 'exact',
    },
    cards: {
      bookingRequests: { notifyTeam: false, pauseAi: false, stopOnBooked: false },
      humanContact: { notifyTeam: false },
      customerDefers: { enabled: false, delay: '7d', message: 'm' },
      hiredAnother: { enabled: false, delay: '30d', message: 'm' },
      optOut: { stopAi: false },
      keyDetails: { notifyOnPhone: false, notifyOnSqft: false, notifyOnQualified: false },
    },
  };
  const { settingsPatch } = savePlaybookView(view);
  // The keys Conversation.tsx writes (Conversation.tsx:205-216):
  const requiredKeys = [
    'followUpStrategy',
    'priceQuoteMode',
    // 'followUpAvailability', // INTENTIONALLY excluded — Decision #1 Option B
    'aiStopOnOptOut',
    'aiStopOnBooked',
    'aiStopOnPriceAgreed',
    'handoffTriggerAgreed',
    'handoffTriggerWantsLiveContact',
    'handoffTriggerProvidedPhone',
    'handoffTriggerProvidedSquareFootage',
    'handoffTriggerQualificationComplete',
  ];
  for (const k of requiredKeys) {
    assert(k in settingsPatch, `S10 key reachable: ${k}`);
  }
  // Plus the deferral/competitor keys that live on Services.tsx today —
  // Playbook absorbs them too.
  const extraKeys = [
    'aiDeferralCheckIn', 'aiDeferralDelay', 'aiDeferralMessage',
    'aiHiredCompetitorReengage', 'aiHiredCompetitorDelay', 'aiHiredCompetitorMessage',
  ];
  for (const k of extraKeys) {
    assert(k in settingsPatch, `S10 extra key reachable: ${k}`);
  }
}

// Helper alias to keep the scenario 10 input shape concise.
type DeepPartialAll<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartialAll<T[K]> : T[K];
};

// ─── Entry point ──────────────────────────────────────────────────────────

export function runVerification(): number {
  const scenarios: Array<[string, () => void]> = [
    ['1: round-trip',                runScenario1_RoundTrip],
    ['2: defaults',                  runScenario2_Defaults],
    ['3: partial optOut write',      runScenario3_PartialOptOut],
    ['4: partial whenAiReplies',     runScenario4_PartialWhenAiReplies],
    ['5: mirror write from booking', runScenario5_MirrorWriteBooking],
    ['6: mirror write from human',   runScenario6_MirrorWriteHuman],
    ['7: mirror read',               runScenario7_MirrorRead],
    ['8: Decision #1 Option B',      runScenario8_DecisionOneOptionB],
    ['9: column DTO shape',          runScenario9_ColumnDtoShape],
    ['10: Conversation key coverage',runScenario10_ConversationKeyCoverage],
  ];
  for (const [label, fn] of scenarios) {
    fn();
    // eslint-disable-next-line no-console
    console.log(`[playbook-adapter] PASS scenario ${label}`);
  }
  return scenarios.length;
}
