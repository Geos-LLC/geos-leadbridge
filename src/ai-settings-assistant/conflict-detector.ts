/**
 * Conflict detector — compares a proposed new rule against the current
 * text of the targeted Playbook section and decides one of:
 *
 *   - 'compatible' — new rule does not contradict or duplicate existing
 *                    language. Caller should mint an `append` proposal.
 *   - 'duplicate'  — new rule restates / re-phrases something already in
 *                    the section. Caller should return `status: noop`.
 *   - 'conflict'   — new rule contradicts a specific sentence in the
 *                    section. Caller should return `status: conflict`
 *                    with 3 resolution options.
 *
 * Design notes:
 *
 * 1. The verdict + the exact conflicting / duplicated excerpt come back
 *    in a single LLM call so the caller can build a replace-conflicting-
 *    rule proposal without a second round-trip.
 *
 * 2. We extract a single short excerpt verbatim from the existing text.
 *    The caller does a literal substring replace on it — never an LLM
 *    rewrite of the section — so the user can audit the diff and a
 *    hallucinated rewrite can't silently mutate unrelated language.
 *
 * 3. On any LLM error / parse failure / timeout, the detector returns
 *    `compatible` with `fromLlm: false`. The service layer treats this
 *    as the safe fallback: append the new rule + show the strong "review
 *    both" warning we shipped in the prior commit. Better to add a
 *    redundant rule than block the user when the LLM is flaky.
 *
 * 4. Tests inject a fake `LlmCaller` so the conflict logic can be
 *    exercised against canned LLM responses without hitting OpenAI.
 */

import OpenAI from 'openai';

export type ConflictVerdict = 'compatible' | 'duplicate' | 'conflict';

export interface ConflictDetectorResult {
  verdict: ConflictVerdict;
  /**
   * The literal excerpt from `currentValue` that the new rule
   * duplicates or contradicts. Always a verbatim substring of the
   * input — never paraphrased. Empty string when verdict='compatible'.
   */
  conflictingExcerpt: string;
  /** Short human-readable explanation for the UI conflict card. */
  explanation: string;
  /** False when the detector fell back (LLM error / timeout / parse fail). */
  fromLlm: boolean;
}

export interface ConflictDetectorContext {
  /** Current Playbook section text (may be multi-paragraph). */
  currentValue: string;
  /** The newly-proposed rule text. */
  newValue: string;
  /** Area key — passed to the LLM for context ("pricing_guidance" vs "brand_voice" affects what counts as a contradiction). */
  area: string;
}

/**
 * Pluggable LLM call. Tests pass a stub returning canned responses.
 * Real wiring passes an OpenAI client.
 */
export type LlmCaller = (
  systemPrompt: string,
  userPrompt: string,
) => Promise<string>;

const SYSTEM_PROMPT = `You compare a NEW rule against the CURRENT text of a Playbook section. Return JSON only.

Schema:
{
  "verdict": "compatible" | "duplicate" | "conflict",
  "conflictingExcerpt": "verbatim substring of CURRENT (or empty string when compatible)",
  "explanation": "8-20 words explaining the verdict"
}

Definitions:

- compatible — The NEW rule covers a topic the CURRENT text does not address, OR it adds a refinement that does not contradict anything in CURRENT. Default when in doubt and the two clearly don't overlap.

- duplicate — The NEW rule says substantively the same thing as a sentence already in CURRENT, with the same direction (don't / always / never). Re-phrasings count: "Sound warmer" vs "Use a warm tone" → duplicate. Trivially synonymous: "We bring all standard cleaning supplies" vs "Tell customers we bring supplies" → duplicate. The conflictingExcerpt is the duplicated sentence from CURRENT.

- conflict — The NEW rule contradicts a specific sentence in CURRENT. The direction must be opposite: "don't quote before square footage" vs "always quote right away" → conflict. "Don't offer trainee cleaners" vs "Offer trainee cleaners as a cheaper option" → conflict. The conflictingExcerpt is the contradicted sentence from CURRENT, copied verbatim.

Rules:

1. conflictingExcerpt MUST be a verbatim substring of CURRENT (case + punctuation preserved). If you can't identify a single specific sentence, choose 'compatible' rather than fabricating an excerpt.

2. Two rules in the same direction with different scopes are NOT a conflict ("don't quote before square footage" vs "don't quote before bedroom count" — both restrict pricing; the new one is a refinement, return compatible).

3. Adjacent topics are NOT a conflict ("we bring supplies" vs "we are insured" — different facts; compatible).

4. A new rule that adds an exception to a current rule IS a conflict ("never offer discounts" vs "offer 10% off for first-time customers" — return conflict so the user can decide).

5. When choosing between duplicate and compatible: only return duplicate if the new rule is genuinely redundant. A new rule that adds detail to an existing rule is compatible.

6. When choosing between conflict and compatible: only return conflict if you can quote the exact contradicting sentence. A vague tension that doesn't pin to one sentence is compatible.

7. Conservative default is COMPATIBLE — false positives on conflict / duplicate are worse than false negatives. Blocking a benign rule frustrates users more than a redundant append.

Output one JSON object. No prose.`;

const LLM_TIMEOUT_MS = 6000;

export async function detectConflict(
  llm: LlmCaller,
  ctx: ConflictDetectorContext,
): Promise<ConflictDetectorResult> {
  const cur = (ctx.currentValue || '').trim();
  const nxt = (ctx.newValue || '').trim();
  if (!cur || !nxt) {
    return { verdict: 'compatible', conflictingExcerpt: '', explanation: 'no existing rules to compare against', fromLlm: false };
  }

  const userPrompt = `AREA: ${ctx.area}

CURRENT text in this section:
"""
${cur}
"""

NEW rule the user wants to add:
"""
${nxt}
"""

Classify the relationship. Output JSON.`;

  let raw: string;
  try {
    raw = await Promise.race<string>([
      llm(SYSTEM_PROMPT, userPrompt),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('llm_timeout')), LLM_TIMEOUT_MS)),
    ]);
  } catch {
    return { verdict: 'compatible', conflictingExcerpt: '', explanation: 'detector unavailable; falling back to append', fromLlm: false };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { verdict: 'compatible', conflictingExcerpt: '', explanation: 'detector returned malformed JSON; falling back to append', fromLlm: false };
  }

  const verdict: ConflictVerdict =
    parsed?.verdict === 'duplicate' ? 'duplicate' :
    parsed?.verdict === 'conflict' ? 'conflict' :
    'compatible';
  const explanationRaw = typeof parsed?.explanation === 'string' ? parsed.explanation.trim() : '';
  const explanation = explanationRaw || 'classified by AI conflict detector';
  let excerpt = typeof parsed?.conflictingExcerpt === 'string' ? parsed.conflictingExcerpt.trim() : '';

  // Excerpt MUST be a verbatim substring of the current value. If the
  // LLM hallucinated one, downgrade to 'compatible' rather than write
  // a fabricated quote into the conflict card.
  if (verdict !== 'compatible') {
    if (!excerpt || !cur.includes(excerpt)) {
      return { verdict: 'compatible', conflictingExcerpt: '', explanation: 'detector excerpt did not match section; falling back to append', fromLlm: true };
    }
  } else {
    excerpt = '';
  }

  return { verdict, conflictingExcerpt: excerpt, explanation, fromLlm: true };
}

/**
 * Bind an OpenAI client to the LlmCaller signature. Service code uses
 * this; tests don't (they pass a stub directly).
 */
export function openAiLlmCaller(client: OpenAI): LlmCaller {
  return async (systemPrompt, userPrompt) => {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 250,
      temperature: 0,
      response_format: { type: 'json_object' },
    });
    return completion.choices?.[0]?.message?.content?.trim() || '';
  };
}
