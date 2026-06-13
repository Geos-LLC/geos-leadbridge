/**
 * Classify a natural-language settings request to one of the MVP areas.
 *
 * Two layers:
 *   1. Rule-based prefilter (fast, no LLM call) catches the obvious cases
 *      and is the only path used in unit tests so they don't need an API
 *      key.
 *   2. LLM fallback (gpt-4o-mini) for ambiguous cases. The LLM is given a
 *      STRICT allowlist of areas — any other return value is treated as
 *      'unknown' so a hallucinated area can't silently become a write.
 *
 * The classifier ONLY decides the area + operation + canonical newValue.
 * It does NOT decide whether to apply or whether there's a conflict; that
 * lives in the service so we can wire safety + signing around it.
 */

import OpenAI from 'openai';
import { AssistantArea, AssistantOperation } from './assistant.types';

export interface ClassifierResult {
  /** 'unknown' = we couldn't confidently map to any MVP area. */
  area: AssistantArea | 'unknown';
  operation: AssistantOperation;
  /** The text the writer should append/replace/set. For add_faq, this is the answer. */
  newValue: string;
  /** Only set for add_faq — the question half of the pair. */
  faqQuestion?: string;
  /** Short rationale for logs and the proposal summary. */
  rationale: string;
  /** 0..1 — how confident we are in `area`. <0.55 → ask for clarification. */
  confidence: number;
  /** True when this came from the LLM rather than the rule-based prefilter. */
  fromLlm: boolean;
}

// Phrases that map almost certainly to a specific area. Order matters —
// faq must be checked before business_information because "if they ask"
// is the canonical FAQ tell, and that phrase otherwise looks business-y.
interface Rule {
  area: AssistantArea;
  operation: AssistantOperation;
  patterns: RegExp[];
  /** Short label for logs. */
  reason: string;
}

const RULES: Rule[] = [
  {
    area: 'faq',
    operation: 'add_faq',
    patterns: [
      /\bif (they|customers?|the customer) (asks?|wants? to know|wonders?)\b/i,
      /\bwhen (they|customers?) asks?\b/i,
      /\banswer (to|for)\b.{0,40}\b(question|faq)\b/i,
      /\badd (a|an) (faq|q&a)\b/i,
    ],
    reason: 'Phrased as an if-asked Q&A — FAQ surface.',
  },
  {
    area: 'pricing_guidance',
    operation: 'append',
    patterns: [
      /\b(don'?t|do not|never) (quote|give|share|mention) .{0,40}(price|cost|estimate)/i,
      /\b(always|only) (quote|give|share) .{0,40}(price|range|cost)/i,
      /\bprice .{0,30}range\b/i,
      /\b(quote|pricing) (rule|policy)\b/i,
      /\boffer (cheaper|trainee|discount|promo)\b/i,
      /\b(without|unless) .{0,40}(square footage|sq ?ft|sqft|bedrooms?|details?)\b/i,
    ],
    reason: 'Pricing behavior rule — Pricing Guidance.',
  },
  {
    area: 'brand_voice',
    operation: 'append',
    patterns: [
      /\bsound (warmer|friendlier|more friendly|less formal|more casual|professional|less robotic|less salesy)\b/i,
      /\b(use|with) (a )?(friendly|warm|casual|professional|playful|formal) (tone|voice)\b/i,
      /\b(tone|voice|personality) (should|must)\b/i,
      /\bdon'?t sound (robotic|salesy|stiff)\b/i,
      /\bbe (more )?(empathetic|polite|concise)\b/i,
    ],
    reason: 'Tone/voice request — Brand Voice.',
  },
  {
    area: 'business_information',
    operation: 'append',
    patterns: [
      /\b(we|our (business|company|team)) (bring|provide|use|are|have|serve|offer|carry|stock)\b/i,
      /\b(tell|let) (customers?|them) (we|know we)\b/i,
      /\bwe'?re (insured|bonded|licensed|family[- ]owned|woman[- ]owned)\b/i,
      /\bwe service\b/i,
      /\bwe cover\b/i,
    ],
    reason: 'Business fact about your company — Business Information.',
  },
];

function detectFaqPair(message: string): { question: string; answer: string } | null {
  // "If they ask X, say Y" / "When they ask X, tell them Y" / "Answer to X: Y"
  const ifAsk = message.match(/\bif (?:they|customers?|the customer) (?:asks? (?:about|if)?\s+)?(.{3,120}?)[,:]\s*(?:say|tell them|reply with|answer)[:\s]+(.{3,400})$/i);
  if (ifAsk) return { question: ifAsk[1].trim(), answer: ifAsk[2].trim() };

  const whenAsk = message.match(/\bwhen (?:they|customers?) asks?\s+(?:about\s+)?(.{3,120}?)[,:]\s*(?:say|tell them|reply with|answer)[:\s]+(.{3,400})$/i);
  if (whenAsk) return { question: whenAsk[1].trim(), answer: whenAsk[2].trim() };

  const answerTo = message.match(/\banswer (?:to|for) ['"]?(.{3,120}?)['"]?\s*[:=]\s*(.{3,400})$/i);
  if (answerTo) return { question: answerTo[1].trim(), answer: answerTo[2].trim() };

  return null;
}

export function classifyByRules(message: string): ClassifierResult | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  for (const rule of RULES) {
    if (rule.patterns.some(p => p.test(trimmed))) {
      // FAQ has structured extraction — we need a question + answer pair
      // before we can confidently propose. If we can't pull one out, fall
      // through to the LLM rather than guessing.
      if (rule.area === 'faq') {
        const pair = detectFaqPair(trimmed);
        if (!pair) return null;
        return {
          area: 'faq',
          operation: 'add_faq',
          newValue: pair.answer,
          faqQuestion: pair.question,
          rationale: rule.reason,
          confidence: 0.85,
          fromLlm: false,
        };
      }
      return {
        area: rule.area,
        operation: rule.operation,
        newValue: trimmed,
        rationale: rule.reason,
        confidence: 0.8,
        fromLlm: false,
      };
    }
  }
  return null;
}

const LLM_SYSTEM_PROMPT = `You route a service-business owner's natural-language settings request to one of the following storage surfaces. Return JSON only, no prose.

Schema:
{
  "area": "business_information" | "pricing_guidance" | "brand_voice" | "faq" | "global_custom_instructions" | "unknown",
  "operation": "append" | "replace" | "set" | "add_faq",
  "newValue": "...",         // the text to write (for add_faq, this is the answer half)
  "faqQuestion": "...",       // ONLY for add_faq — the question half
  "rationale": "8-15 words explaining the routing",
  "confidence": 0..1
}

Area definitions:

- business_information — Facts about the business that AI should know. "We bring supplies", "we are insured", "we serve Tampa". HOW-level facts, not policies.

- pricing_guidance — Rules about WHEN/HOW the AI quotes prices. "Don't quote before square footage", "give ranges not exacts", "offer trainee discount". Anything that constrains pricing behavior.

- brand_voice — Tone, personality, voice. "Sound warmer", "be more casual", "don't be salesy". HOW the AI speaks.

- faq — A specific if-asked Q&A pair. "If they ask about pets, say we work around them". Requires both a question topic AND an answer; if one is missing, use 'unknown' instead.

- global_custom_instructions — Tenant-wide guidance that doesn't fit the four buckets above and isn't tied to a specific surface. Use this LAST — only when the other four are wrong. Examples: cross-surface preferences, unusual one-off rules.

- unknown — The request is too vague, mixes multiple targets, asks for something outside the MVP scope (business hours, templates, pricing table rows, goal switching), or is missing required info.

Operation rules:

- "append" — Add to existing custom instructions. Default for business_information, pricing_guidance, brand_voice.
- "set" — Replace the entire field. Use for global_custom_instructions when the user clearly wants a wholesale rewrite.
- "add_faq" — Append a new Q&A pair to faqJson. Only valid when area='faq'.
- "replace" — Replace specific existing language. Rare; prefer append.

Confidence:
- ≥0.85 — Unambiguous request, the area is the obvious fit.
- 0.6-0.8 — Plausible routing but could arguably be a sibling area.
- <0.6 — Ambiguous; caller will ask for clarification.

Never invent business facts. The newValue should be a clean, prose-ready rewrite of the user's request that reads naturally as a Playbook instruction.`;

const LLM_TIMEOUT_MS = 6000;

export async function classifyByLlm(
  client: OpenAI,
  message: string,
): Promise<ClassifierResult> {
  const completion = await Promise.race<any>([
    client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: LLM_SYSTEM_PROMPT },
        { role: 'user', content: message.trim() },
      ],
      max_tokens: 300,
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('llm_timeout')), LLM_TIMEOUT_MS)),
  ]);

  const raw = completion.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('empty_llm_response');
  const parsed = JSON.parse(raw);

  const allowedAreas: ReadonlyArray<AssistantArea | 'unknown'> = [
    'business_information',
    'pricing_guidance',
    'brand_voice',
    'faq',
    'global_custom_instructions',
    'unknown',
  ];
  const allowedOps: ReadonlyArray<AssistantOperation> = ['append', 'replace', 'set', 'add_faq'];

  const area = allowedAreas.includes(parsed.area) ? (parsed.area as AssistantArea | 'unknown') : 'unknown';
  const operation = allowedOps.includes(parsed.operation) ? (parsed.operation as AssistantOperation) : 'append';
  const newValue = typeof parsed.newValue === 'string' ? parsed.newValue.trim() : '';
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';
  const confidence = typeof parsed.confidence === 'number'
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0;
  const faqQuestion = typeof parsed.faqQuestion === 'string' ? parsed.faqQuestion.trim() : undefined;

  return {
    area,
    operation: area === 'faq' ? 'add_faq' : operation,
    newValue,
    faqQuestion,
    rationale,
    confidence,
    fromLlm: true,
  };
}
