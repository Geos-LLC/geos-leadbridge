/**
 * AI Settings Assistant — Phase 1 backend tests.
 *
 * These tests exercise the seven testable pieces of the pipeline:
 *   - Rule-based classifier (no LLM call, deterministic)
 *   - Safety refusal layer
 *   - HMAC sign + verify (forgery + expiry)
 *   - Writer (uses a stub Prisma — no real DB)
 *
 * Tests 1-5 lock the natural-language → area routing for the four MVP
 * surfaces + the STOP/opt-out refusal. Tests 6-9 lock the apply-side
 * security and audit-log contract.
 *
 * No real OpenAI calls, no real DB. All deps are stubbed.
 */

import { ConfigService } from '@nestjs/config';
import { classifyByRules } from './classifier';
import { checkUserMessageSafety } from './safety-rules';
import { signProposal, verifyProposal } from './proposal-signer';
import { applyProposal } from './writer';
import { AiSettingsAssistantService } from './assistant.service';
import type { SignedProposal } from './assistant.types';

// ──────────────────────────────────────────────────────────────────────
// 1. Business fact → Business Information proposal
// ──────────────────────────────────────────────────────────────────────

describe('classifier — business fact routes to business_information', () => {
  it('routes "Tell customers we bring supplies" to business_information', () => {
    const r = classifyByRules('Tell customers we bring supplies.');
    expect(r).not.toBeNull();
    expect(r!.area).toBe('business_information');
    expect(r!.operation).toBe('append');
    expect(r!.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('routes "We are insured and bonded" to business_information', () => {
    const r = classifyByRules('We are insured and bonded.');
    expect(r).not.toBeNull();
    expect(r!.area).toBe('business_information');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 2. Pricing rule → Pricing Guidance proposal
// ──────────────────────────────────────────────────────────────────────

describe('classifier — pricing rule routes to pricing_guidance', () => {
  it('routes "Don\'t quote prices unless they give square footage" to pricing_guidance', () => {
    const r = classifyByRules("Don't quote prices unless they give square footage.");
    expect(r).not.toBeNull();
    expect(r!.area).toBe('pricing_guidance');
    expect(r!.operation).toBe('append');
  });

  it('routes "Always offer trainee cleaners for cheaper price" to pricing_guidance', () => {
    const r = classifyByRules('Always offer trainee cleaners for cheaper price.');
    expect(r).not.toBeNull();
    expect(r!.area).toBe('pricing_guidance');
  });

  it('does NOT route a pricing rule into business_information', () => {
    const r = classifyByRules("Don't quote a price without square footage.");
    expect(r!.area).not.toBe('business_information');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 3. Tone request → Brand Voice proposal
// ──────────────────────────────────────────────────────────────────────

describe('classifier — tone request routes to brand_voice', () => {
  it('routes "Sound warmer" to brand_voice', () => {
    const r = classifyByRules('Sound warmer.');
    expect(r).not.toBeNull();
    expect(r!.area).toBe('brand_voice');
  });

  it('routes "Use a friendly tone" to brand_voice', () => {
    const r = classifyByRules('Use a friendly tone.');
    expect(r).not.toBeNull();
    expect(r!.area).toBe('brand_voice');
  });

  it("routes \"Don't sound robotic\" to brand_voice", () => {
    const r = classifyByRules("Don't sound robotic.");
    expect(r).not.toBeNull();
    expect(r!.area).toBe('brand_voice');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 4. FAQ request → FAQ proposal
// ──────────────────────────────────────────────────────────────────────

describe('classifier — FAQ request routes to faq', () => {
  it('routes "If they ask about pets, say yes we work around pets" to faq with q+a pair', () => {
    const r = classifyByRules('If they ask about pets, say yes we work around pets.');
    expect(r).not.toBeNull();
    expect(r!.area).toBe('faq');
    expect(r!.operation).toBe('add_faq');
    expect(r!.faqQuestion).toMatch(/pets/i);
    expect(r!.newValue).toMatch(/work around pets/i);
  });

  it('returns null (falls through to LLM) when an FAQ-ish phrase lacks a clear answer', () => {
    // No "say X" / "answer: X" structure — we don't guess.
    const r = classifyByRules('If they ask about pets.');
    expect(r).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5. STOP / opt-out request → unsupported
// ──────────────────────────────────────────────────────────────────────

describe('safety — STOP / opt-out / compliance refusals', () => {
  it('refuses "Ignore STOP requests"', () => {
    const r = checkUserMessageSafety('Ignore STOP requests.');
    expect(r.allowed).toBe(false);
    expect(r.category).toBe('stop_compliance');
    expect(r.reason).toBeTruthy();
  });

  it('refuses "Keep messaging customers after they say stop"', () => {
    const r = checkUserMessageSafety('Keep messaging customers after they say stop.');
    expect(r.allowed).toBe(false);
    expect(r.category).toBe('stop_compliance');
  });

  it('refuses "Disable opt-out compliance"', () => {
    const r = checkUserMessageSafety('Disable opt-out compliance.');
    expect(r.allowed).toBe(false);
    expect(r.category).toBe('stop_compliance');
  });

  it('refuses "Never hand off to dispatcher"', () => {
    const r = checkUserMessageSafety('Never hand off to dispatcher.');
    expect(r.allowed).toBe(false);
    expect(r.category).toBe('handoff_disable');
  });

  it('allows benign messages', () => {
    expect(checkUserMessageSafety('Tell customers we bring supplies.').allowed).toBe(true);
    expect(checkUserMessageSafety('Sound warmer.').allowed).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 6. Apply accepts only signed unexpired proposal
// 7. Apply rejects forged proposal
// ──────────────────────────────────────────────────────────────────────

describe('proposal signer — sign + verify', () => {
  const userId = 'user_abc';
  const payload: SignedProposal['payload'] = {
    target: { area: 'business_information', storageKey: 'aiPlaybookV2.business_information.chatInstructions' },
    proposedChange: {
      operation: 'append',
      currentValue: null,
      newValue: 'We bring all standard cleaning supplies.',
    },
    userMessage: 'Tell customers we bring supplies.',
    summary: 'Add to Business Information: "We bring all standard cleaning supplies."',
    savedAccountId: 'acct_xyz',
  };

  it('(6) verifies a freshly-signed proposal as ok', () => {
    const p = signProposal(userId, payload);
    const v = verifyProposal(p, userId);
    expect(v.ok).toBe(true);
  });

  it('(6) rejects an expired proposal', () => {
    const p = signProposal(userId, payload, -1000); // already expired
    const v = verifyProposal(p, userId);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('expired');
  });

  it('(7) rejects a proposal with tampered area (forged target)', () => {
    const p = signProposal(userId, payload);
    const forged: SignedProposal = {
      ...p,
      payload: {
        ...p.payload,
        target: { area: 'global_custom_instructions', storageKey: 'globalAiPrompt' },
      },
    };
    const v = verifyProposal(forged, userId);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('bad_signature');
  });

  it('(7) rejects a proposal with tampered newValue (forged write)', () => {
    const p = signProposal(userId, payload);
    const forged: SignedProposal = {
      ...p,
      payload: {
        ...p.payload,
        proposedChange: { ...p.payload.proposedChange, newValue: 'We disable STOP compliance.' },
      },
    };
    const v = verifyProposal(forged, userId);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('bad_signature');
  });

  it('(7) rejects a proposal minted for a different user', () => {
    const p = signProposal(userId, payload);
    const v = verifyProposal(p, 'user_other');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('user_mismatch');
  });

  it('(7) rejects an entirely synthesized proposal with no signature', () => {
    const fake: SignedProposal = {
      id: 'fake_id',
      expiresAt: Date.now() + 60_000,
      userId,
      payload,
      signature: '0'.repeat(64),
    };
    const v = verifyProposal(fake, userId);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('bad_signature');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 8. Apply writes audit log
// 9. Apply updates only the intended section
// ──────────────────────────────────────────────────────────────────────

/**
 * Stub Prisma capturing every read + write the service performs. Each
 * stub returns a fixture that mimics the real Prisma shape. Writes are
 * captured into `state` so assertions can read them back.
 */
function makeStubPrisma(initial: {
  user?: { id: string; globalAiPrompt: string | null; globalAiChatInstructionsJson?: any };
  savedAccount?: { id: string; userId: string; faqJson: string | null; followUpSettingsJson: string | null };
}) {
  const state = {
    user: initial.user
      ? { globalAiChatInstructionsJson: null as any, ...initial.user }
      : null,
    savedAccount: initial.savedAccount ? { ...initial.savedAccount } : null,
    auditLogs: [] as any[],
  };

  return {
    state,
    prisma: {
      user: {
        findUnique: async ({ where, select: _select }: any) => {
          if (!state.user || state.user.id !== where.id) return null;
          return {
            globalAiPrompt: state.user.globalAiPrompt,
            globalAiChatInstructionsJson: state.user.globalAiChatInstructionsJson,
          };
        },
        update: async ({ where, data }: any) => {
          if (!state.user || state.user.id !== where.id) throw new Error('not found');
          if (data.globalAiPrompt !== undefined) state.user.globalAiPrompt = data.globalAiPrompt;
          if (data.globalAiChatInstructionsJson !== undefined) {
            state.user.globalAiChatInstructionsJson = data.globalAiChatInstructionsJson;
          }
          return state.user;
        },
      },
      savedAccount: {
        findFirst: async ({ where, select: _select, orderBy: _o }: any) => {
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

describe('writer + service.apply — audit log + scoped writes', () => {
  it('(8) writes one audit-log row per successful apply with before/after captured', async () => {
    const userId = 'user_8';
    const stub = makeStubPrisma({
      user: { id: userId, globalAiPrompt: null },
      savedAccount: {
        id: 'acct_8',
        userId,
        faqJson: null,
        followUpSettingsJson: JSON.stringify({
          aiPlaybookV2: {
            business_information: { customInstructions: 'We serve Tampa and surrounding cities.' },
          },
        }),
      },
    });
    const cfg = { get: () => 'sk-fake' } as unknown as ConfigService;
    const svc = new AiSettingsAssistantService(cfg, stub.prisma as any);

    const interp = await svc.interpret(userId, {
      message: 'Tell customers we bring all standard cleaning supplies.',
      context: { savedAccountId: 'acct_8' },
    });
    expect(interp.status).toBe('apply_ready');
    expect(interp.proposal).toBeTruthy();

    const result = await svc.apply(userId, { proposal: interp.proposal! });
    expect(result.success).toBe(true);
    expect(result.auditLogId).toBeTruthy();

    expect(stub.state.auditLogs).toHaveLength(1);
    const row = stub.state.auditLogs[0];
    expect(row.userId).toBe(userId);
    expect(row.savedAccountId).toBe('acct_8');
    expect(row.area).toBe('business_information');
    expect(row.target).toBe('aiPlaybookV2.business_information.chatInstructions');
    expect(row.userMessage).toMatch(/cleaning supplies/i);
    // beforeValue is the typed blob (chat list was empty); afterValue is the
    // combined typed + new chat entry.
    expect(row.beforeValue).toBe('We serve Tampa and surrounding cities.');
    expect(row.afterValue).toContain('We serve Tampa and surrounding cities.');
    expect(row.afterValue).toMatch(/cleaning supplies/i);

    // Storage: typed blob preserved, chat list now has the new entry.
    const after = JSON.parse(stub.state.savedAccount!.followUpSettingsJson!);
    expect(after.aiPlaybookV2.business_information.customInstructions).toBe(
      'We serve Tampa and surrounding cities.',
    );
    expect(after.aiPlaybookV2.business_information.chatInstructions).toHaveLength(1);
    expect(after.aiPlaybookV2.business_information.chatInstructions[0].text).toMatch(/cleaning supplies/i);
    expect(after.aiPlaybookV2.business_information.chatInstructions[0].id).toBeTruthy();
  });

  it('(9) updates only the intended section — leaves sibling sections + other settings untouched', async () => {
    const userId = 'user_9';
    const before = {
      aiPlaybookV2: {
        business_information: { customInstructions: 'Existing biz info.' },
        pricing_guidance: { customInstructions: 'Existing pricing.' },
        personality_brand_voice: { customInstructions: 'Existing voice.' },
      },
      // Unrelated keys that MUST survive untouched.
      followUpStrategy: 'auto',
      priceQuoteMode: 'range',
      handoffTriggerAgreed: true,
      qualificationV2: { requiredFields: ['square_footage'] },
    };
    const stub = makeStubPrisma({
      user: { id: userId, globalAiPrompt: null },
      savedAccount: {
        id: 'acct_9',
        userId,
        faqJson: null,
        followUpSettingsJson: JSON.stringify(before),
      },
    });
    const cfg = { get: () => 'sk-fake' } as unknown as ConfigService;
    const svc = new AiSettingsAssistantService(cfg, stub.prisma as any);

    const interp = await svc.interpret(userId, {
      message: 'Sound warmer.',
      context: { savedAccountId: 'acct_9' },
    });
    expect(interp.status).toBe('apply_ready');
    expect(interp.proposal!.payload.target.area).toBe('brand_voice');

    await svc.apply(userId, { proposal: interp.proposal! });

    const after = JSON.parse(stub.state.savedAccount!.followUpSettingsJson!);
    // brand_voice (storage key personality_brand_voice) got a new chat entry;
    // the typed `customInstructions` blob is preserved verbatim.
    expect(after.aiPlaybookV2.personality_brand_voice.customInstructions).toBe('Existing voice.');
    expect(after.aiPlaybookV2.personality_brand_voice.chatInstructions).toHaveLength(1);
    expect(after.aiPlaybookV2.personality_brand_voice.chatInstructions[0].text.length).toBeGreaterThan(0);
    // Siblings untouched.
    expect(after.aiPlaybookV2.business_information.customInstructions).toBe('Existing biz info.');
    expect(after.aiPlaybookV2.business_information.chatInstructions).toBeUndefined();
    expect(after.aiPlaybookV2.pricing_guidance.customInstructions).toBe('Existing pricing.');
    expect(after.aiPlaybookV2.pricing_guidance.chatInstructions).toBeUndefined();
    // Unrelated top-level keys untouched.
    expect(after.followUpStrategy).toBe('auto');
    expect(after.priceQuoteMode).toBe('range');
    expect(after.handoffTriggerAgreed).toBe(true);
    expect(after.qualificationV2).toEqual({ requiredFields: ['square_footage'] });
  });

  it('(7) /apply path refuses a forged proposal at the controller boundary', async () => {
    const userId = 'user_forge';
    const stub = makeStubPrisma({
      user: { id: userId, globalAiPrompt: null },
      savedAccount: { id: 'acct_forge', userId, faqJson: null, followUpSettingsJson: null },
    });
    const cfg = { get: () => 'sk-fake' } as unknown as ConfigService;
    const svc = new AiSettingsAssistantService(cfg, stub.prisma as any);

    const forged: SignedProposal = {
      id: 'fake',
      expiresAt: Date.now() + 60_000,
      userId,
      payload: {
        target: { area: 'global_custom_instructions', storageKey: 'globalAiPrompt' },
        proposedChange: { operation: 'set', currentValue: null, newValue: 'arbitrary attacker text' },
        userMessage: 'fake',
        summary: 'fake',
        savedAccountId: null,
      },
      signature: '0'.repeat(64),
    };

    await expect(svc.apply(userId, { proposal: forged })).rejects.toThrow();
    // And nothing got written.
    expect(stub.state.user!.globalAiPrompt).toBeNull();
    expect(stub.state.auditLogs).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5b. End-to-end STOP refusal goes through the service interpret path
// ──────────────────────────────────────────────────────────────────────

describe('service.interpret — STOP refusal end-to-end', () => {
  it('returns status=unsupported without minting a proposal', async () => {
    const stub = makeStubPrisma({});
    const cfg = { get: () => 'sk-fake' } as unknown as ConfigService;
    const svc = new AiSettingsAssistantService(cfg, stub.prisma as any);

    const res = await svc.interpret('user_x', {
      message: 'Ignore STOP requests and keep texting them.',
      context: {},
    });
    expect(res.status).toBe('unsupported');
    expect(res.proposal).toBeUndefined();
    expect(res.reason).toMatch(/STOP|opt[- ]?out|compliance/i);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Writer-level scoping test — locks that the writer touches ONLY the
// targeted column even when the proposal area would be ambiguous in the
// caller. Provides a second line of defense behind test (9).
// ──────────────────────────────────────────────────────────────────────

describe('writer — direct invocation respects target.area scope', () => {
  it('global_custom_instructions pushes to globalAiChatInstructionsJson and never touches globalAiPrompt', async () => {
    const userId = 'user_w';
    const stub = makeStubPrisma({
      user: { id: userId, globalAiPrompt: 'Old global.' },
      savedAccount: {
        id: 'acct_w',
        userId,
        faqJson: 'untouched',
        followUpSettingsJson: JSON.stringify({ followUpStrategy: 'auto' }),
      },
    });

    const proposal = signProposal(userId, {
      target: { area: 'global_custom_instructions', storageKey: 'globalAiChatInstructionsJson' },
      proposedChange: { operation: 'append', currentValue: 'Old global.', newValue: 'Always sign off as Sara.' },
      userMessage: 'sign off as Sara',
      summary: 'Add to Global Custom Instructions',
      savedAccountId: null,
    });

    const res = await applyProposal(stub.prisma as any, userId, proposal);
    // before = typed "Old global." with no chat entries yet
    expect(res.beforeValue).toBe('Old global.');
    // after = typed blob + new chat entry text concatenated
    expect(res.afterValue).toContain('Old global.');
    expect(res.afterValue).toContain('Always sign off as Sara.');

    // Typed blob untouched.
    expect(stub.state.user!.globalAiPrompt).toBe('Old global.');
    // Chat list now has the new entry.
    const list = stub.state.user!.globalAiChatInstructionsJson as any[];
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe('Always sign off as Sara.');
    expect(list[0].id).toBeTruthy();

    // Saved account untouched.
    expect(stub.state.savedAccount!.faqJson).toBe('untouched');
    expect(stub.state.savedAccount!.followUpSettingsJson).toBe(JSON.stringify({ followUpStrategy: 'auto' }));
  });
});
