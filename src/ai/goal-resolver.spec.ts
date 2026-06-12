/**
 * Tests for the shared Conversation-Goal resolver.
 *
 * Covers the contract from the Goal/Strategy Runtime Alignment refactor:
 *   - `auto` routes dynamically on all three surfaces (Lead Arrives,
 *     AI Conversation, Follow-ups) by calling suggestStrategy at runtime.
 *     Pre-refactor, only the follow-up generator did this; the other two
 *     fell back to hybrid silently.
 *   - Legacy saved values `hybrid` and `convert` resolve cleanly to their
 *     STRATEGY_PROMPTS entries without crashing — they're no longer
 *     selectable in the UI picker but must keep working at runtime.
 *   - The UI's selectable goal catalogue (SELECTABLE_GOAL_KEYS) excludes
 *     hybrid and convert.
 *
 * The three "surface" tests share the same helper because the wiring in
 * automation.service.ts and follow-up-generator.service.ts both funnel
 * through resolveActiveGoal — the surface-specific differences are which
 * fields each caller populates (rule overrides on Surfaces 1/2; thread
 * override on Surface 3). Each surface test pins the input shape its
 * caller actually passes today.
 */

import {
  resolveActiveGoal,
  SELECTABLE_GOAL_KEYS,
  SUPPORTED_GOAL_KEYS,
  type GoalResolverDeps,
  type ResolveGoalInput,
} from './goal-resolver';
import { STRATEGY_PROMPTS } from './strategy-prompts';

function buildSuggestStub(returnValue: {
  suggested: string;
  reason: string;
  confidence?: number;
} | null): { stub: GoalResolverDeps['suggestStrategy']; calls: string[] } {
  const calls: string[] = [];
  const stub: GoalResolverDeps['suggestStrategy'] = async (id: string) => {
    calls.push(id);
    return returnValue;
  };
  return { stub, calls };
}

describe('resolveActiveGoal — Auto routes on all three surfaces', () => {
  it('Lead Arrives: account=auto + threadId → calls suggestStrategy and returns the suggestion', async () => {
    const { stub, calls } = buildSuggestStub({
      suggested: 'price',
      reason: 'price-shopping detected',
      confidence: 0.82,
    });
    // Inputs that match Surface 1 (new_lead AutomationRule running through
    // executePendingMessage): rule has no replyMode override, no per-rule
    // template, no legacy prompt. Account default = auto. Thread context
    // present because executePendingMessage runs after the Conversation
    // row has been ensured (lead.threadId = conversation.id).
    const surfaceInput: ResolveGoalInput = {
      ruleForcePrice: false,
      rulePromptOverride: null,
      ruleLegacyPrompt: null,
      threadActiveStrategy: null,
      accountFollowUpStrategy: 'auto',
      accountFollowUpStrategyPrompt: null,
      conversationId: 'thread-lead-arrives-1',
    };
    const result = await resolveActiveGoal(surfaceInput, { suggestStrategy: stub });
    expect(calls).toEqual(['thread-lead-arrives-1']);
    expect(result.source).toBe('auto_routed');
    expect(result.goalKey).toBe('price');
    expect(result.strategyPrompt).toBe(STRATEGY_PROMPTS.price);
  });

  it('AI Conversation: account=auto + customer reply mid-thread → routes via suggestStrategy', async () => {
    // Surface 2 reaches executePendingMessage via the synthetic rule path
    // (no AutomationRule rows, aiConversationEnabled=true). The synthetic
    // rule has no replyMode, no promptTemplate, no aiSystemPrompt. Thread
    // is mid-conversation so threadId exists.
    const { stub, calls } = buildSuggestStub({
      suggested: 'qualify',
      reason: '3 missing fields',
    });
    const result = await resolveActiveGoal(
      {
        ruleForcePrice: false,
        rulePromptOverride: null,
        ruleLegacyPrompt: null,
        threadActiveStrategy: null,
        accountFollowUpStrategy: 'auto',
        accountFollowUpStrategyPrompt: null,
        conversationId: 'thread-ai-conversation-9',
      },
      { suggestStrategy: stub },
    );
    expect(calls).toEqual(['thread-ai-conversation-9']);
    expect(result.source).toBe('auto_routed');
    expect(result.goalKey).toBe('qualify');
    expect(result.strategyPrompt).toBe(STRATEGY_PROMPTS.qualify);
  });

  it('Follow-up: account=auto + scheduled step → routes via suggestStrategy', async () => {
    // Surface 3 (FollowUpGeneratorService.generateFromAI). Same auto
    // routing as the other two now — pre-refactor this was the ONLY
    // surface that called suggestStrategy. Uses 'qualify' as the
    // suggested goal to match the post-rewrite router contract (legacy
    // goals only reach the resolver via the saved-account branch now).
    const { stub, calls } = buildSuggestStub({
      suggested: 'qualify',
      reason: 'no explicit signal — qualifying the lead',
    });
    const result = await resolveActiveGoal(
      {
        threadActiveStrategy: null,
        accountFollowUpStrategy: 'auto',
        accountFollowUpStrategyPrompt: null,
        conversationId: 'thread-followup-step-3',
      },
      { suggestStrategy: stub },
    );
    expect(calls).toEqual(['thread-followup-step-3']);
    expect(result.source).toBe('auto_routed');
    expect(result.goalKey).toBe('qualify');
    expect(result.strategyPrompt).toBe(STRATEGY_PROMPTS.qualify);
  });

  it('Auto routing falls through to hybrid fallback when suggestStrategy returns null', async () => {
    const { stub } = buildSuggestStub(null);
    const result = await resolveActiveGoal(
      {
        accountFollowUpStrategy: 'auto',
        conversationId: 'thread-no-suggestion',
      },
      { suggestStrategy: stub },
    );
    expect(result.source).toBe('fallback_hybrid');
    expect(result.goalKey).toBe('hybrid');
    expect(result.strategyPrompt).toBe(STRATEGY_PROMPTS.hybrid);
  });

  it('Auto routing survives suggestStrategy throwing — falls through to fallback', async () => {
    const stub: GoalResolverDeps['suggestStrategy'] = async () => {
      throw new Error('thread context backend down');
    };
    const result = await resolveActiveGoal(
      {
        accountFollowUpStrategy: 'auto',
        conversationId: 'thread-error',
      },
      { suggestStrategy: stub },
    );
    expect(result.source).toBe('fallback_hybrid');
    expect(result.goalKey).toBe('hybrid');
  });

  it('Auto routing skipped when conversationId is missing — falls through to fallback', async () => {
    const { stub, calls } = buildSuggestStub({ suggested: 'price', reason: 'x' });
    const result = await resolveActiveGoal(
      { accountFollowUpStrategy: 'auto', conversationId: null },
      { suggestStrategy: stub },
    );
    expect(calls).toEqual([]); // never called without a thread to route on
    expect(result.source).toBe('fallback_hybrid');
  });
});

describe('resolveActiveGoal — Legacy saved values do not crash', () => {
  // The UI no longer offers Hybrid or Convert as selectable goals (the
  // picker on Conversation.tsx is narrowed to Auto/Price/Qualify/Phone),
  // but accounts that picked one of those before the narrow-down still
  // have the value persisted in followUpSettingsJson.followUpStrategy.
  // The runtime MUST honour them without crashing — and must NOT call
  // suggestStrategy (they're explicit choices, not auto).

  it('saved followUpStrategy="hybrid" resolves to STRATEGY_PROMPTS.hybrid', async () => {
    const { stub, calls } = buildSuggestStub({ suggested: 'price', reason: 'x' });
    const result = await resolveActiveGoal(
      {
        accountFollowUpStrategy: 'hybrid',
        conversationId: 'thread-legacy-hybrid',
      },
      { suggestStrategy: stub },
    );
    expect(result.goalKey).toBe('hybrid');
    expect(result.strategyPrompt).toBe(STRATEGY_PROMPTS.hybrid);
    expect(result.source).toBe('account_default');
    expect(calls).toEqual([]); // not auto-routed
  });

  it('saved followUpStrategy="convert" resolves to STRATEGY_PROMPTS.convert', async () => {
    const { stub, calls } = buildSuggestStub({ suggested: 'qualify', reason: 'x' });
    const result = await resolveActiveGoal(
      {
        accountFollowUpStrategy: 'convert',
        conversationId: 'thread-legacy-convert',
      },
      { suggestStrategy: stub },
    );
    expect(result.goalKey).toBe('convert');
    expect(result.strategyPrompt).toBe(STRATEGY_PROMPTS.convert);
    expect(result.source).toBe('account_default');
    expect(calls).toEqual([]);
  });

  it('legacy hybrid/convert still honour a user-customised prompt body', async () => {
    const { stub } = buildSuggestStub({ suggested: 'price', reason: 'x' });
    const result = await resolveActiveGoal(
      {
        accountFollowUpStrategy: 'hybrid',
        accountFollowUpStrategyPrompt: 'CUSTOM BODY — keep this verbatim.',
        conversationId: 'thread-legacy-custom',
      },
      { suggestStrategy: stub },
    );
    expect(result.goalKey).toBe('hybrid');
    expect(result.strategyPrompt).toBe('CUSTOM BODY — keep this verbatim.');
    expect(result.source).toBe('account_custom_prompt');
  });

  it('unknown saved value falls through to auto routing / fallback', async () => {
    // Garbage / future / unrecognised key. Must not crash — must not be
    // treated as a STRATEGY_PROMPTS hit. Falls through to whatever the
    // later branches resolve to (auto routing if conversationId, else
    // hybrid fallback).
    const { stub } = buildSuggestStub({ suggested: 'phone', reason: 'x' });
    const result = await resolveActiveGoal(
      {
        accountFollowUpStrategy: 'space_disco_5000',
        conversationId: 'thread-garbage',
      },
      { suggestStrategy: stub },
    );
    expect(result.source).toBe('auto_routed');
    expect(result.goalKey).toBe('phone');
  });
});

describe('resolveActiveGoal — explicit goal selections take precedence', () => {
  it('rule.replyMode="price" wins over account default and auto routing', async () => {
    const { stub, calls } = buildSuggestStub({ suggested: 'convert', reason: 'x' });
    const result = await resolveActiveGoal(
      {
        ruleForcePrice: true,
        accountFollowUpStrategy: 'auto',
        conversationId: 'thread-1',
      },
      { suggestStrategy: stub },
    );
    expect(result.source).toBe('rule_force_price');
    expect(result.goalKey).toBe('price');
    expect(calls).toEqual([]); // no auto routing when forced
  });

  it('rule promptTemplate.content wins over account default but yields goalKey=null', async () => {
    const { stub } = buildSuggestStub({ suggested: 'convert', reason: 'x' });
    const result = await resolveActiveGoal(
      {
        rulePromptOverride: 'SPECIAL RULE PROMPT',
        accountFollowUpStrategy: 'qualify',
        conversationId: 'thread-1',
      },
      { suggestStrategy: stub },
    );
    expect(result.source).toBe('rule_prompt_template');
    expect(result.goalKey).toBeNull(); // pre-refactor behaviour
    expect(result.strategyPrompt).toBe('SPECIAL RULE PROMPT');
  });

  it('explicit account goal beats thread override and auto routing', async () => {
    const { stub, calls } = buildSuggestStub({ suggested: 'convert', reason: 'x' });
    const result = await resolveActiveGoal(
      {
        threadActiveStrategy: 'phone',
        accountFollowUpStrategy: 'qualify',
        conversationId: 'thread-1',
      },
      { suggestStrategy: stub },
    );
    expect(result.source).toBe('account_default');
    expect(result.goalKey).toBe('qualify');
    expect(calls).toEqual([]);
  });

  it('thread override fires when account is auto/empty', async () => {
    const { stub, calls } = buildSuggestStub({ suggested: 'price', reason: 'x' });
    const result = await resolveActiveGoal(
      {
        threadActiveStrategy: 'phone',
        accountFollowUpStrategy: 'auto',
        conversationId: 'thread-1',
      },
      { suggestStrategy: stub },
    );
    expect(result.source).toBe('thread_active_override');
    expect(result.goalKey).toBe('phone');
    expect(calls).toEqual([]); // thread override beats auto routing
  });

  it('rule.aiSystemPrompt only kicks in when nothing else resolves', async () => {
    const { stub } = buildSuggestStub(null);
    const result = await resolveActiveGoal(
      {
        ruleLegacyPrompt: 'LEGACY FREE-FORM',
        conversationId: null,
      },
      { suggestStrategy: stub },
    );
    expect(result.source).toBe('rule_legacy_prompt');
    expect(result.goalKey).toBeNull();
    expect(result.strategyPrompt).toBe('LEGACY FREE-FORM');
  });
});

describe('resolveActiveGoal — Auto routing normalizes legacy goal leaks', () => {
  // Post-rewrite contract (2026-06-12): the new suggestStrategy() only
  // emits price | qualify | phone, but if any other code path hands the
  // resolver a legacy 'hybrid' or 'convert' suggestion via the auto-routed
  // branch, the resolver normalizes it to 'qualify' so user-visible Auto
  // never resolves to a hidden legacy goal.
  //
  // Critical: this normalization applies ONLY to source='auto_routed'.
  // Explicit saved hybrid/convert (covered in "Legacy saved values do
  // not crash" above) still resolves to its original prompt.

  it('Auto-routed "hybrid" suggestion normalizes to qualify', async () => {
    const stub = async () => ({
      suggested: 'hybrid',
      reason: 'legacy router output',
    });
    const result = await resolveActiveGoal(
      { accountFollowUpStrategy: 'auto', conversationId: 'thread-legacy-from-auto' },
      { suggestStrategy: stub },
    );
    expect(result.source).toBe('auto_routed');
    expect(result.goalKey).toBe('qualify');
    expect(result.strategyPrompt).toBe(STRATEGY_PROMPTS.qualify);
    expect(result.reason).toContain('normalized from hybrid');
  });

  it('Auto-routed "convert" suggestion normalizes to qualify', async () => {
    const stub = async () => ({
      suggested: 'convert',
      reason: 'legacy router output',
    });
    const result = await resolveActiveGoal(
      { accountFollowUpStrategy: 'auto', conversationId: 'thread-legacy-from-auto' },
      { suggestStrategy: stub },
    );
    expect(result.source).toBe('auto_routed');
    expect(result.goalKey).toBe('qualify');
    expect(result.strategyPrompt).toBe(STRATEGY_PROMPTS.qualify);
    expect(result.reason).toContain('normalized from convert');
  });

  it('Auto-routed visible goals pass through without normalization', async () => {
    for (const goal of ['price', 'qualify', 'phone'] as const) {
      const stub = async () => ({ suggested: goal, reason: 'router' });
      const result = await resolveActiveGoal(
        { accountFollowUpStrategy: 'auto', conversationId: 't' },
        { suggestStrategy: stub },
      );
      expect(result.source).toBe('auto_routed');
      expect(result.goalKey).toBe(goal);
      expect(result.strategyPrompt).toBe(STRATEGY_PROMPTS[goal]);
      expect(result.reason).not.toContain('normalized from');
    }
  });

  it('Explicit account-saved "hybrid" is NOT normalized — uses hybrid prompt', async () => {
    // Same input shape as "Legacy saved values" tests above, but framed
    // explicitly against the normalization contract: explicit tenant
    // choice wins, no remap. The auto branch + its normalization never
    // fires here.
    const stub = async () => ({ suggested: 'qualify', reason: 'router' });
    const result = await resolveActiveGoal(
      { accountFollowUpStrategy: 'hybrid', conversationId: 't' },
      { suggestStrategy: stub },
    );
    expect(result.source).toBe('account_default');
    expect(result.goalKey).toBe('hybrid');
    expect(result.strategyPrompt).toBe(STRATEGY_PROMPTS.hybrid);
  });

  it('Explicit account-saved "convert" is NOT normalized — uses convert prompt', async () => {
    const stub = async () => ({ suggested: 'qualify', reason: 'router' });
    const result = await resolveActiveGoal(
      { accountFollowUpStrategy: 'convert', conversationId: 't' },
      { suggestStrategy: stub },
    );
    expect(result.source).toBe('account_default');
    expect(result.goalKey).toBe('convert');
    expect(result.strategyPrompt).toBe(STRATEGY_PROMPTS.convert);
  });

  it('Thread-level "hybrid" / "convert" overrides are also not normalized', async () => {
    // ThreadContext.activeStrategy is a per-thread manual override (set
    // by an operator from Lead Activity). Treat it as explicit — same
    // category as account-saved — so back-compat for any thread the
    // operator pinned to a legacy goal stays intact.
    const stub = async () => ({ suggested: 'qualify', reason: 'router' });
    for (const goal of ['hybrid', 'convert'] as const) {
      const result = await resolveActiveGoal(
        {
          threadActiveStrategy: goal,
          accountFollowUpStrategy: 'auto',
          conversationId: 't',
        },
        { suggestStrategy: stub },
      );
      expect(result.source).toBe('thread_active_override');
      expect(result.goalKey).toBe(goal);
      expect(result.strategyPrompt).toBe(STRATEGY_PROMPTS[goal]);
    }
  });
});

describe('SELECTABLE_GOAL_KEYS — UI no longer exposes Hybrid/Convert', () => {
  // Contract: the UI picker on Conversation.tsx must render exactly these
  // four goals — Auto, Price, Qualify, Phone. Hybrid and Convert are valid
  // runtime values for back-compat (see "Legacy saved values" tests above)
  // but cannot be CHOSEN by the user any more. This list is the canonical
  // export the frontend should import from; any future picker added in
  // another surface should also draw from here.

  it('exposes exactly auto / price / qualify / phone as selectable', () => {
    expect([...SELECTABLE_GOAL_KEYS]).toEqual(['auto', 'price', 'qualify', 'phone']);
  });

  it('does not include "hybrid" as a selectable goal', () => {
    expect(SELECTABLE_GOAL_KEYS).not.toContain('hybrid' as never);
  });

  it('does not include "convert" as a selectable goal', () => {
    expect(SELECTABLE_GOAL_KEYS).not.toContain('convert' as never);
  });

  it('every selectable non-auto key maps to a STRATEGY_PROMPTS entry', () => {
    for (const key of SELECTABLE_GOAL_KEYS) {
      if (key === 'auto') continue;
      expect(STRATEGY_PROMPTS[key]).toBeTruthy();
    }
  });

  it('every SUPPORTED_GOAL_KEY (including legacy hybrid/convert) maps to STRATEGY_PROMPTS', () => {
    // Runtime contract — even if UI hides them, prompts MUST still exist
    // for the resolver to honour saved values without crashing.
    for (const key of SUPPORTED_GOAL_KEYS) {
      expect(STRATEGY_PROMPTS[key]).toBeTruthy();
    }
    expect(SUPPORTED_GOAL_KEYS).toContain('hybrid');
    expect(SUPPORTED_GOAL_KEYS).toContain('convert');
  });
});
