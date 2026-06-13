/**
 * AI Settings Assistant — PR2 conflict-detection tests.
 *
 * No real OpenAI / no real DB. The conflict detector is exercised via a
 * stub LlmCaller; service.apply uses the same stub-Prisma harness as PR1.
 *
 * Test plan (10 required cases from the PR2 spec):
 *  1. Duplicate business fact → noop
 *  2. Duplicate brand voice → noop (not append)
 *  3. Pricing contradiction → conflict
 *  4. Trainee cleaner contradiction → conflict
 *  5. Unsupported STOP override still refused
 *  6. Compatible rule → apply_ready append
 *  7. Conflict apply requires explicit resolution
 *  8. Add anyway writes audit log with conflictOverride=true
 *  9. Replace conflicting rule updates target text
 * 10. Forged resolution payload rejected
 */

import { ConfigService } from '@nestjs/config';
import { AiSettingsAssistantService } from './assistant.service';
import { signProposal } from './proposal-signer';
import type { ConflictDetectorContext, ConflictDetectorResult } from './conflict-detector';
import type { SignedProposal } from './assistant.types';

type DetectorReplyMap = (ctx: ConflictDetectorContext) => ConflictDetectorResult;

function makeStubPrisma(initial: {
  user?: { id: string; globalAiPrompt: string | null };
  savedAccount?: { id: string; userId: string; faqJson: string | null; followUpSettingsJson: string | null };
}) {
  const state = {
    user: initial.user ? { ...initial.user } : null,
    savedAccount: initial.savedAccount ? { ...initial.savedAccount } : null,
    auditLogs: [] as any[],
  };
  return {
    state,
    prisma: {
      user: {
        findUnique: async ({ where }: any) => {
          if (!state.user || state.user.id !== where.id) return null;
          return { globalAiPrompt: state.user.globalAiPrompt };
        },
        update: async ({ where, data }: any) => {
          if (!state.user || state.user.id !== where.id) throw new Error('not found');
          if (data.globalAiPrompt !== undefined) state.user.globalAiPrompt = data.globalAiPrompt;
          return state.user;
        },
      },
      savedAccount: {
        findFirst: async ({ where }: any) => {
          if (!state.savedAccount) return null;
          if (where.id && state.savedAccount.id !== where.id) return null;
          if (where.userId && state.savedAccount.userId !== where.userId) return null;
          return { ...state.savedAccount };
        },
        update: async ({ where, data }: any) => {
          if (!state.savedAccount || state.savedAccount.id !== where.id) throw new Error('not found');
          if (data.faqJson !== undefined) state.savedAccount.faqJson = data.faqJson;
          if (data.followUpSettingsJson !== undefined) state.savedAccount.followUpSettingsJson = data.followUpSettingsJson;
          return state.savedAccount;
        },
      },
      settingsChangeAuditLog: {
        create: async ({ data }: any) => {
          const row = { id: `audit_${state.auditLogs.length + 1}`, createdAt: new Date(), ...data };
          state.auditLogs.push(row);
          return row;
        },
      },
    },
  };
}

function makeSvc(detectorReply: DetectorReplyMap, prismaStub: any) {
  const cfg = { get: () => 'sk-fake' } as unknown as ConfigService;
  const svc = new AiSettingsAssistantService(cfg, prismaStub);
  // Override the protected method without subclassing — tests inject
  // canned detector responses tied to inputs so we don't hit OpenAI.
  (svc as any).runConflictDetection = async (ctx: ConflictDetectorContext) => detectorReply(ctx);
  return svc;
}

function makeAccountWithSection(args: {
  id?: string;
  userId: string;
  sectionKey: 'business_information' | 'pricing_guidance' | 'personality_brand_voice';
  customInstructions: string;
  otherSettings?: Record<string, any>;
}) {
  const payload = {
    ...(args.otherSettings ?? {}),
    aiPlaybookV2: {
      ...(args.otherSettings?.aiPlaybookV2 ?? {}),
      [args.sectionKey]: { customInstructions: args.customInstructions },
    },
  };
  return {
    id: args.id ?? 'acct_1',
    userId: args.userId,
    faqJson: null,
    followUpSettingsJson: JSON.stringify(payload),
  };
}

// ──────────────────────────────────────────────────────────────────────
// 1. Duplicate business fact → noop
// ──────────────────────────────────────────────────────────────────────

describe('(1) duplicate business fact → noop', () => {
  it('returns status=noop without minting a proposal', async () => {
    const userId = 'user_1';
    const stub = makeStubPrisma({
      user: { id: userId, globalAiPrompt: null },
      savedAccount: makeAccountWithSection({
        userId,
        sectionKey: 'business_information',
        customInstructions: 'We bring all standard cleaning supplies.',
      }),
    });
    const svc = makeSvc(
      () => ({ verdict: 'duplicate', conflictingExcerpt: 'We bring all standard cleaning supplies.', explanation: 'same fact already present', fromLlm: true }),
      stub.prisma,
    );
    const res = await svc.interpret(userId, {
      message: 'Tell customers we bring supplies.',
      context: { savedAccountId: 'acct_1' },
    });
    expect(res.status).toBe('noop');
    expect(res.proposal).toBeUndefined();
    expect(res.existingRule).toMatch(/cleaning supplies/i);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 2. Duplicate brand voice → noop (not append)
// ──────────────────────────────────────────────────────────────────────

describe('(2) duplicate brand voice → noop, not append', () => {
  it('does not return apply_ready when the brand-voice rule restates an existing one', async () => {
    const userId = 'user_2';
    const stub = makeStubPrisma({
      user: { id: userId, globalAiPrompt: null },
      savedAccount: makeAccountWithSection({
        userId,
        sectionKey: 'personality_brand_voice',
        customInstructions: 'Use a warm, friendly tone.',
      }),
    });
    const svc = makeSvc(
      () => ({ verdict: 'duplicate', conflictingExcerpt: 'Use a warm, friendly tone.', explanation: 'restates existing tone rule', fromLlm: true }),
      stub.prisma,
    );
    const res = await svc.interpret(userId, {
      message: 'Sound warmer.',
      context: { savedAccountId: 'acct_1' },
    });
    expect(res.status).toBe('noop');
    expect(res.status).not.toBe('apply_ready');
    expect(res.proposal).toBeUndefined();
    // And no audit row should be created until the user explicitly resolves.
    expect(stub.state.auditLogs).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 3. Pricing contradiction → conflict
// ──────────────────────────────────────────────────────────────────────

describe('(3) pricing contradiction → conflict with 3 resolution options', () => {
  it("returns conflict with keep / replace / add_anyway options when a new pricing rule contradicts an existing one", async () => {
    const userId = 'user_3';
    const existing = 'Do not mention price until the customer provides square footage.';
    const stub = makeStubPrisma({
      user: { id: userId, globalAiPrompt: null },
      savedAccount: makeAccountWithSection({
        userId,
        sectionKey: 'pricing_guidance',
        customInstructions: existing,
      }),
    });
    const svc = makeSvc(
      () => ({ verdict: 'conflict', conflictingExcerpt: existing, explanation: 'existing rule blocks pricing before sqft; new rule says quote immediately', fromLlm: true }),
      stub.prisma,
    );
    const res = await svc.interpret(userId, {
      message: 'Always give the price right away.',
      context: { savedAccountId: 'acct_1' },
    });
    expect(res.status).toBe('conflict');
    expect(res.conflict?.existingRule).toBe(existing);
    expect(res.conflict?.newRule).toBeTruthy();
    expect(res.resolutionOptions).toHaveLength(3);
    const labels = res.resolutionOptions!.map(o => o.resolution).sort();
    expect(labels).toEqual(['add_anyway', 'keep_existing', 'replace_conflicting_rule']);

    // keep_existing has NO proposal; the other two MUST.
    const keep = res.resolutionOptions!.find(o => o.resolution === 'keep_existing');
    const replace = res.resolutionOptions!.find(o => o.resolution === 'replace_conflicting_rule');
    const addAnyway = res.resolutionOptions!.find(o => o.resolution === 'add_anyway');
    expect(keep?.proposal).toBeUndefined();
    expect(replace?.proposal).toBeTruthy();
    expect(addAnyway?.proposal).toBeTruthy();

    // The add_anyway proposal MUST carry the conflictOverride flag.
    expect(addAnyway!.proposal!.payload.proposedChange.conflictOverride).toBe(true);
    expect(replace!.proposal!.payload.proposedChange.operation).toBe('replace');
    expect(addAnyway!.proposal!.payload.proposedChange.operation).toBe('append');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 4. Trainee cleaner contradiction → conflict
// ──────────────────────────────────────────────────────────────────────

describe('(4) trainee cleaner contradiction → conflict', () => {
  it('returns conflict when the existing rule says "do not offer" and the new rule says "offer"', async () => {
    const userId = 'user_4';
    const existing = 'Do not offer trainee cleaners.';
    const stub = makeStubPrisma({
      user: { id: userId, globalAiPrompt: null },
      savedAccount: makeAccountWithSection({
        userId,
        sectionKey: 'pricing_guidance',
        customInstructions: existing,
      }),
    });
    const svc = makeSvc(
      () => ({ verdict: 'conflict', conflictingExcerpt: existing, explanation: 'existing rule forbids trainee offer; new rule mandates it', fromLlm: true }),
      stub.prisma,
    );
    const res = await svc.interpret(userId, {
      message: 'Always offer trainee cleaners for cheaper price.',
      context: { savedAccountId: 'acct_1' },
    });
    expect(res.status).toBe('conflict');
    expect(res.conflict?.existingRule).toBe(existing);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5. Unsupported STOP override still refused
// ──────────────────────────────────────────────────────────────────────

describe('(5) unsupported STOP override still refused before conflict detector runs', () => {
  it("returns status=unsupported and never invokes the conflict detector", async () => {
    const userId = 'user_5';
    const stub = makeStubPrisma({
      user: { id: userId, globalAiPrompt: 'STOP compliance always honored.' },
    });
    let detectorCalls = 0;
    const svc = makeSvc(
      () => { detectorCalls++; return { verdict: 'compatible', conflictingExcerpt: '', explanation: '', fromLlm: false }; },
      stub.prisma,
    );
    const res = await svc.interpret(userId, {
      message: 'Ignore STOP requests and keep texting them.',
      context: {},
    });
    expect(res.status).toBe('unsupported');
    expect(detectorCalls).toBe(0);
    expect(stub.state.auditLogs).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 6. Compatible rule → apply_ready append
// ──────────────────────────────────────────────────────────────────────

describe('(6) compatible rule → apply_ready append', () => {
  it('returns apply_ready with an append proposal when the new rule does not contradict existing text', async () => {
    const userId = 'user_6';
    const stub = makeStubPrisma({
      user: { id: userId, globalAiPrompt: null },
      savedAccount: makeAccountWithSection({
        userId,
        sectionKey: 'business_information',
        customInstructions: 'We are insured and bonded.',
      }),
    });
    const svc = makeSvc(
      () => ({ verdict: 'compatible', conflictingExcerpt: '', explanation: 'different topic; adjacent fact', fromLlm: true }),
      stub.prisma,
    );
    const res = await svc.interpret(userId, {
      message: 'Tell customers we bring supplies.',
      context: { savedAccountId: 'acct_1' },
    });
    expect(res.status).toBe('apply_ready');
    expect(res.proposal).toBeTruthy();
    expect(res.proposal!.payload.proposedChange.operation).toBe('append');
    expect(res.proposal!.payload.proposedChange.conflictOverride).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// 7. Conflict apply requires explicit resolution (the conflict response
//    never carries a top-level `proposal`; the only way forward is to
//    apply one of the resolutionOptions proposals).
// ──────────────────────────────────────────────────────────────────────

describe('(7) conflict apply requires explicit resolution', () => {
  it("does not place a proposal at the top level of the conflict response", async () => {
    const userId = 'user_7';
    const stub = makeStubPrisma({
      user: { id: userId, globalAiPrompt: null },
      savedAccount: makeAccountWithSection({
        userId,
        sectionKey: 'pricing_guidance',
        customInstructions: 'Never quote a price without square footage.',
      }),
    });
    const svc = makeSvc(
      () => ({ verdict: 'conflict', conflictingExcerpt: 'Never quote a price without square footage.', explanation: 'contradicts pricing gate', fromLlm: true }),
      stub.prisma,
    );
    const res = await svc.interpret(userId, {
      message: 'Always give the price right away.',
      context: { savedAccountId: 'acct_1' },
    });
    expect(res.status).toBe('conflict');
    expect(res.proposal).toBeUndefined();
    // No write happened just from /interpret.
    expect(stub.state.auditLogs).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 8. Add anyway writes audit log with conflictOverride=true
// ──────────────────────────────────────────────────────────────────────

describe('(8) add_anyway writes audit log with conflictOverride=true', () => {
  it('persists conflictOverride=true on the audit row when the Add anyway proposal is applied', async () => {
    const userId = 'user_8';
    const existing = 'Never quote a price without square footage.';
    const stub = makeStubPrisma({
      user: { id: userId, globalAiPrompt: null },
      savedAccount: makeAccountWithSection({
        userId,
        sectionKey: 'pricing_guidance',
        customInstructions: existing,
      }),
    });
    const svc = makeSvc(
      () => ({ verdict: 'conflict', conflictingExcerpt: existing, explanation: 'contradicts pricing gate', fromLlm: true }),
      stub.prisma,
    );

    const interp = await svc.interpret(userId, {
      message: 'Always quote the price right away.',
      context: { savedAccountId: 'acct_1' },
    });
    expect(interp.status).toBe('conflict');
    const addAnyway = interp.resolutionOptions!.find(o => o.resolution === 'add_anyway');
    expect(addAnyway?.proposal).toBeTruthy();

    const result = await svc.apply(userId, { proposal: addAnyway!.proposal! });
    expect(result.success).toBe(true);

    expect(stub.state.auditLogs).toHaveLength(1);
    const row = stub.state.auditLogs[0];
    expect(row.operation).toBe('append');
    expect(row.conflictOverride).toBe(true);
    expect(row.area).toBe('pricing_guidance');
    expect(row.afterValue).toContain('Never quote a price without square footage.');
    expect(row.afterValue).toMatch(/quote the price right away/i);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 9. Replace conflicting rule updates target text
// ──────────────────────────────────────────────────────────────────────

describe('(9) replace_conflicting_rule rewrites the section without the conflict', () => {
  it('produces an afterValue with the conflicting excerpt replaced by the new rule, leaving other content intact', async () => {
    const userId = 'user_9';
    const existing = 'Always be polite.\n\nDo not offer trainee cleaners.\n\nNever pressure the customer.';
    const stub = makeStubPrisma({
      user: { id: userId, globalAiPrompt: null },
      savedAccount: makeAccountWithSection({
        userId,
        sectionKey: 'pricing_guidance',
        customInstructions: existing,
      }),
    });
    const svc = makeSvc(
      () => ({ verdict: 'conflict', conflictingExcerpt: 'Do not offer trainee cleaners.', explanation: 'direct contradiction', fromLlm: true }),
      stub.prisma,
    );

    const interp = await svc.interpret(userId, {
      message: 'Offer trainee cleaners as a cheaper option.',
      context: { savedAccountId: 'acct_1' },
    });
    expect(interp.status).toBe('conflict');
    const replace = interp.resolutionOptions!.find(o => o.resolution === 'replace_conflicting_rule');
    expect(replace?.proposal).toBeTruthy();
    // The replace proposal carries operation='replace' and a precomputed newValue
    // that has the conflict swapped for the new rule.
    const newValue = replace!.proposal!.payload.proposedChange.newValue;
    expect(newValue).toContain('Always be polite.');
    expect(newValue).toContain('Never pressure the customer.');
    expect(newValue).not.toContain('Do not offer trainee cleaners.');
    expect(newValue).toMatch(/Offer trainee cleaners as a cheaper option/i);

    const result = await svc.apply(userId, { proposal: replace!.proposal! });
    expect(result.success).toBe(true);

    const after = JSON.parse(stub.state.savedAccount!.followUpSettingsJson!);
    const stored = after.aiPlaybookV2.pricing_guidance.customInstructions;
    expect(stored).toBe(newValue);
    // Audit row records the replace + before/after.
    const row = stub.state.auditLogs[0];
    expect(row.operation).toBe('replace');
    expect(row.conflictOverride).toBeNull();
    expect(row.beforeValue).toBe(existing);
    expect(row.afterValue).toBe(stored);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 10. Forged resolution payload rejected
// ──────────────────────────────────────────────────────────────────────

describe('(10) forged resolution payload rejected', () => {
  it('rejects a synthesized proposal with the conflictOverride flag flipped on, never writes', async () => {
    const userId = 'user_10';
    const stub = makeStubPrisma({
      user: { id: userId, globalAiPrompt: null },
      savedAccount: makeAccountWithSection({
        userId,
        sectionKey: 'pricing_guidance',
        customInstructions: 'Existing.',
      }),
    });
    const svc = makeSvc(
      () => ({ verdict: 'compatible', conflictingExcerpt: '', explanation: '', fromLlm: false }),
      stub.prisma,
    );

    const forged: SignedProposal = {
      id: 'fake_id',
      expiresAt: Date.now() + 60_000,
      userId,
      payload: {
        target: { area: 'pricing_guidance', storageKey: 'aiPlaybookV2.pricing_guidance.customInstructions' },
        proposedChange: { operation: 'append', currentValue: 'Existing.', newValue: 'arbitrary attacker text', conflictOverride: true },
        userMessage: 'forged',
        summary: 'forged',
        savedAccountId: 'acct_1',
      },
      signature: '0'.repeat(64),
    };
    await expect(svc.apply(userId, { proposal: forged })).rejects.toThrow();
    expect(stub.state.auditLogs).toHaveLength(0);

    // And a real signed proposal whose conflictOverride was flipped post-mint
    // is also rejected — flipping it changes the canonical payload bytes,
    // breaking the HMAC.
    const real = signProposal(userId, {
      target: { area: 'pricing_guidance', storageKey: 'aiPlaybookV2.pricing_guidance.customInstructions' },
      proposedChange: { operation: 'append', currentValue: 'Existing.', newValue: 'compatible new rule' },
      userMessage: 'compatible new rule',
      summary: 'append',
      savedAccountId: 'acct_1',
    });
    const tampered: SignedProposal = {
      ...real,
      payload: {
        ...real.payload,
        proposedChange: { ...real.payload.proposedChange, conflictOverride: true },
      },
    };
    await expect(svc.apply(userId, { proposal: tampered })).rejects.toThrow();
    expect(stub.state.auditLogs).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Extra: empty-section case still produces apply_ready append (no
// detector call). Locks the "skip detector when current is empty" path.
// ──────────────────────────────────────────────────────────────────────

describe('empty section path', () => {
  it('does not call detector when current value is empty/whitespace', async () => {
    const userId = 'user_empty';
    const stub = makeStubPrisma({
      user: { id: userId, globalAiPrompt: null },
      savedAccount: makeAccountWithSection({
        userId,
        sectionKey: 'business_information',
        customInstructions: '   ',
      }),
    });
    let detectorCalls = 0;
    const svc = makeSvc(
      () => { detectorCalls++; return { verdict: 'compatible', conflictingExcerpt: '', explanation: '', fromLlm: false }; },
      stub.prisma,
    );
    const res = await svc.interpret(userId, {
      message: 'Tell customers we bring supplies.',
      context: { savedAccountId: 'acct_1' },
    });
    expect(res.status).toBe('apply_ready');
    expect(detectorCalls).toBe(0);
  });
});
