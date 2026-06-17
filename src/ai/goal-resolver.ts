/**
 * Conversation-Goal Resolver — single source of truth used by all three
 * AI-reply surfaces (Lead Arrives instant reply, AI Conversation customer
 * replies, Follow-up generation).
 *
 * Why one helper:
 *   Before this file, three separate code paths each had their own
 *   priority chain for picking which STRATEGY_PROMPT body to inject.
 *   `auto` only routed dynamically inside the follow-up generator; the
 *   other two surfaces treated it as a no-op and fell through to the
 *   hybrid fallback. Centralising the decision here makes `auto` mean
 *   the same thing everywhere: "ask suggestStrategy() at runtime."
 *
 * Field naming:
 *   The persisted JSON key on `SavedAccount.followUpSettingsJson` is still
 *   `followUpStrategy` (no API/DB migration in this refactor). The
 *   user-facing label is "Conversation Goal". Internally we treat the two
 *   as synonymous and accept either spelling — see ResolveGoalInput below.
 *
 * Back-compat:
 *   Legacy saved values `hybrid` and `convert` are no longer exposed in
 *   the UI picker. The runtime still honours them via STRATEGY_PROMPTS so
 *   accounts that picked one of those before the narrowing don't crash
 *   and don't silently lose their saved prompt body.
 */

import { STRATEGY_PROMPTS } from './strategy-prompts';

/**
 * Internal canonical key set. Auto is a router, never a final goal.
 *
 * `booking` (2026-06-16) is the new user-selectable "schedule the job"
 * goal. `phone` is the internal key for the Call Handoff goal — the UI
 * label changed but the key stays put so existing
 * `SavedAccount.followUpSettingsJson.followUpStrategy='phone'` values
 * resolve unchanged.
 */
export type GoalKey = 'hybrid' | 'price' | 'qualify' | 'convert' | 'phone' | 'booking';

/**
 * All goal keys the prompt layer understands. Used by tests + callers that
 * need to validate inbound values. `auto` is intentionally not part of
 * this list — it is a routing instruction, not a goal.
 */
export const SUPPORTED_GOAL_KEYS: readonly GoalKey[] =
  ['hybrid', 'price', 'qualify', 'convert', 'phone', 'booking'] as const;

/**
 * Goal keys the UI may render as selectable cards. `hybrid` and `convert`
 * are intentionally excluded — they remain valid runtime values for
 * back-compat with accounts that saved them before the picker was
 * narrowed, but new selections cannot produce them. See parseSettings in
 * frontend/src/pages/automation/Conversation.tsx for the display remap.
 *
 * Order matters — this is also the on-screen card order. `phone` displays
 * as "Call Handoff" in the UI; the saved key stays `phone` for back-compat.
 */
export const SELECTABLE_GOAL_KEYS: readonly ('auto' | GoalKey)[] =
  ['auto', 'price', 'qualify', 'booking', 'phone'] as const;

export interface ResolveGoalInput {
  /**
   * Legacy Instant-Reply "Price mode" override on the AutomationRule
   * row (`rule.replyMode === 'price'`). Surface-1/2 only. Wins over
   * everything. New UI no longer sets this but old rows may still have it.
   */
  ruleForcePrice?: boolean;
  /**
   * Per-rule custom prompt body (`rule.promptTemplate.content`). When set,
   * the user has explicitly edited the First-Reply prompt for that
   * automation; we honour it verbatim and treat the goal as "unknown" so
   * that downstream side-effects keyed on goal (e.g. Qualify pricing
   * suppression) stay off — matching pre-refactor behaviour.
   */
  rulePromptOverride?: string | null;
  /**
   * Legacy free-form prompt on the AutomationRule (`rule.aiSystemPrompt`).
   * Only used as a late fallback when nothing else resolves.
   */
  ruleLegacyPrompt?: string | null;
  /**
   * Per-thread manual override stored on `ThreadContext.activeStrategy`.
   * Honoured when the account default is `auto` / empty; an explicit
   * account-level choice still wins (intentional — account default
   * represents tenant policy, thread override represents "I touched this
   * one conversation").
   */
  threadActiveStrategy?: string | null;
  /**
   * Raw `followUpStrategy` from `SavedAccount.followUpSettingsJson`.
   * May be 'auto', 'hybrid', 'convert', 'price', 'qualify', 'phone',
   * undefined, or an unknown string. We normalise inside the resolver.
   */
  accountFollowUpStrategy?: string | null;
  /**
   * User-customised prompt body for the account-level goal
   * (`followUpStrategyPrompt`). Only applied when the account goal is a
   * concrete non-auto value; ignored when auto-routing.
   */
  accountFollowUpStrategyPrompt?: string | null;
  /**
   * Conversation/thread id, required to auto-route. When omitted and the
   * account goal is `auto`, we cannot call suggestStrategy and fall
   * through to the legacy/fallback branch.
   */
  conversationId?: string | null;
}

export type GoalResolutionSource =
  | 'rule_force_price'
  | 'rule_prompt_template'
  | 'account_custom_prompt'
  | 'account_default'
  | 'thread_active_override'
  | 'auto_routed'
  | 'rule_legacy_prompt'
  | 'fallback_hybrid';

export interface ResolvedGoal {
  /**
   * Canonical goal key the prompt was drawn from. `null` when a rule-level
   * verbatim prompt fully replaced the strategy body — callers that gate
   * side-effects on goal identity (qualification block injection,
   * qualify-pricing suppression) should treat null as "skip side-effect",
   * matching pre-refactor behaviour.
   */
  goalKey: GoalKey | null;
  /** Prompt body to inject as the PRIMARY INSTRUCTION layer. */
  strategyPrompt: string;
  /** Short human-readable reason — surfaces in logs and audit trails. */
  reason: string;
  /** Structured source tag for telemetry + tests. */
  source: GoalResolutionSource;
}

export interface GoalResolverDeps {
  /**
   * Same shape as ConversationContextService.suggestStrategy. Pulled in
   * as a dependency rather than importing the service directly so this
   * file stays Nest-free and easy to unit-test.
   */
  suggestStrategy: (conversationId: string) => Promise<{
    suggested: string;
    reason: string;
    confidence?: number;
  } | null>;
}

/**
 * Resolve which prompt body the AI should use right now.
 *
 * Priority chain (highest to lowest):
 *   1. rule.replyMode === 'price'  (legacy force-Price)
 *   2. rule.promptTemplate.content (explicit per-rule override)
 *   3. account-level explicit non-auto goal (with optional custom prompt)
 *   4. thread-level manual override (ThreadContext.activeStrategy)
 *   5. account-level `auto` (or empty) → suggestStrategy()
 *   6. rule.aiSystemPrompt          (legacy free-form prompt)
 *   7. hybrid fallback
 */
export async function resolveActiveGoal(
  input: ResolveGoalInput,
  deps: GoalResolverDeps,
): Promise<ResolvedGoal> {
  // 1. Legacy Instant-Reply Price-mode override.
  if (input.ruleForcePrice) {
    return {
      goalKey: 'price',
      strategyPrompt: STRATEGY_PROMPTS.price,
      reason: 'rule.replyMode=price',
      source: 'rule_force_price',
    };
  }

  // 2. Per-rule explicit prompt template. Goal stays unknown by design.
  if (input.rulePromptOverride) {
    return {
      goalKey: null,
      strategyPrompt: input.rulePromptOverride,
      reason: 'rule.promptTemplate',
      source: 'rule_prompt_template',
    };
  }

  // 3. Account default — explicit non-auto choice wins over thread override
  //    AND auto routing. Honours user-customised prompt body.
  const rawAccount = (input.accountFollowUpStrategy ?? '').trim();
  if (rawAccount && rawAccount !== 'auto' && STRATEGY_PROMPTS[rawAccount]) {
    const goalKey = rawAccount as GoalKey;
    const customPrompt = input.accountFollowUpStrategyPrompt?.trim();
    if (customPrompt) {
      return {
        goalKey,
        strategyPrompt: customPrompt,
        reason: `account default (${goalKey}, custom prompt)`,
        source: 'account_custom_prompt',
      };
    }
    return {
      goalKey,
      strategyPrompt: STRATEGY_PROMPTS[goalKey],
      reason: `account default (${goalKey})`,
      source: 'account_default',
    };
  }

  // 4. Thread-level manual override — only fires when account is auto/empty.
  if (
    input.threadActiveStrategy
    && STRATEGY_PROMPTS[input.threadActiveStrategy]
  ) {
    const goalKey = input.threadActiveStrategy as GoalKey;
    return {
      goalKey,
      strategyPrompt: STRATEGY_PROMPTS[goalKey],
      reason: 'thread override',
      source: 'thread_active_override',
    };
  }

  // 5. AUTO routing — pre-refactor this branch only existed inside the
  //    follow-up generator. Lifting it here means Lead Arrives + AI
  //    Conversation now also route dynamically when goal=auto, matching
  //    the "Auto = AI chooses the best goal" UI promise.
  //
  //    Legacy-goal normalization (2026-06-12): the new suggestStrategy()
  //    only emits `phone` | `price` | `qualify`, but other code paths
  //    (older ThreadContext.suggestedStrategy rows, tests, future
  //    routers) could still hand us `hybrid` or `convert`. When the
  //    suggestion is one of those hidden legacy goals, normalize to
  //    `qualify` — the new broad default after the 4-goal narrowing.
  //
  //    Critical: this normalization fires ONLY on `auto_routed`.
  //    Explicit tenant choices saved as `hybrid` / `convert` are handled
  //    by branch #3 above and continue to use STRATEGY_PROMPTS.hybrid /
  //    .convert as written — back-compat for legacy tenants is preserved.
  if (input.conversationId) {
    try {
      const suggestion = await deps.suggestStrategy(input.conversationId);
      if (suggestion && STRATEGY_PROMPTS[suggestion.suggested]) {
        const rawSuggestion = suggestion.suggested;
        const isLegacy = rawSuggestion === 'hybrid' || rawSuggestion === 'convert';
        const goalKey: GoalKey = isLegacy ? 'qualify' : (rawSuggestion as GoalKey);
        const reasonPrefix = isLegacy
          ? `auto (normalized from ${rawSuggestion}): `
          : 'auto: ';
        return {
          goalKey,
          strategyPrompt: STRATEGY_PROMPTS[goalKey],
          reason: reasonPrefix + suggestion.reason,
          source: 'auto_routed',
        };
      }
    } catch {
      // suggestStrategy is best-effort — fall through on error so the
      // reply still gets a sensible default.
    }
  }

  // 6. Rule-level legacy free-form prompt.
  if (input.ruleLegacyPrompt) {
    return {
      goalKey: null,
      strategyPrompt: input.ruleLegacyPrompt,
      reason: 'rule.aiSystemPrompt (legacy)',
      source: 'rule_legacy_prompt',
    };
  }

  // 7. Ultimate fallback. Hybrid is the historical default because its
  //    prompt is the least committal of the five (acknowledge + ask
  //    forward) — safe to ship when nothing else resolved.
  return {
    goalKey: 'hybrid',
    strategyPrompt: STRATEGY_PROMPTS.hybrid,
    reason: 'fallback hybrid',
    source: 'fallback_hybrid',
  };
}
