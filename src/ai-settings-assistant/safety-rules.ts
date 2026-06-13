/**
 * Hardcoded safety refusals for the AI Settings Assistant.
 *
 * These checks run BEFORE the LLM call and AGAIN against the LLM's proposed
 * write — so even if the LLM is jailbroken into emitting a permissive
 * proposal, the apply path still rejects it. Two layers, same allowlist.
 *
 * The list intentionally favors false positives (refuse a borderline phrase)
 * over false negatives. A user who gets unfairly refused can rephrase; a
 * user who gets STOP compliance disabled has a CTIA/TCPA exposure.
 */

const STOP_COMPLIANCE_PATTERNS: RegExp[] = [
  /\bignore (the )?stop\b/i,
  /\bignore (the )?opt[- ]?out\b/i,
  /\bignore unsubscribe\b/i,
  /\bdisable stop\b/i,
  /\bdisable opt[- ]?out\b/i,
  /\bdisable unsubscribe\b/i,
  /\bturn off stop\b/i,
  /\bturn off opt[- ]?out\b/i,
  /\bbypass stop\b/i,
  /\bbypass opt[- ]?out\b/i,
  /\bkeep (messaging|texting|contacting|calling).{0,40}(stop|opt[- ]?out|unsubscribe)/i,
  /\b(message|text|contact|call) (them|customers?).{0,40}after.{0,20}(stop|opt[- ]?out|unsubscribe)/i,
  /\bafter they (say|said|type) stop/i,
  /\bafter (opt[- ]?out|unsubscribe)/i,
  /\bopt[- ]?out (doesn['’]t|does not) (count|apply|matter)/i,
  /\bstop (doesn['’]t|does not) (count|apply|matter)/i,
];

const HANDOFF_DISABLE_PATTERNS: RegExp[] = [
  /\bdisable .{0,30}(live contact|handoff|hand[- ]off)\b/i,
  /\bnever (hand off|handoff|transfer|page (the )?(dispatcher|owner|team|manager))/i,
  /\bignore .{0,30}(live contact|call request)/i,
];

const TERMINAL_LEAD_PATTERNS: RegExp[] = [
  /\bkeep (replying|messaging|texting) (to )?(booked|completed|archived|hired_elsewhere|hired elsewhere)/i,
  /\b(reply|message|text) (to )?(booked|completed|archived) leads?/i,
];

const PROMISE_PATTERNS: RegExp[] = [
  /\bguarantee .{0,30}(availability|price|booking|same day)/i,
  /\bpromise (exact|specific) (time|price)/i,
  /\boffer fake discount/i,
];

export interface SafetyCheckResult {
  allowed: boolean;
  /** Human-friendly reason returned to the user verbatim when allowed=false. */
  reason?: string;
  /** Internal category for logs. */
  category?: 'stop_compliance' | 'handoff_disable' | 'terminal_lead' | 'unsafe_promise';
}

export function checkUserMessageSafety(message: string): SafetyCheckResult {
  if (STOP_COMPLIANCE_PATTERNS.some(p => p.test(message))) {
    return {
      allowed: false,
      category: 'stop_compliance',
      reason: "I can't disable STOP / opt-out compliance. Customers who opt out must not receive further messages — this is a CTIA/TCPA requirement, not a configurable setting.",
    };
  }
  if (HANDOFF_DISABLE_PATTERNS.some(p => p.test(message))) {
    return {
      allowed: false,
      category: 'handoff_disable',
      reason: "I can't disable live-contact handoff. When a customer asks to speak to a human, the dispatcher gets paged — that behavior is protected.",
    };
  }
  if (TERMINAL_LEAD_PATTERNS.some(p => p.test(message))) {
    return {
      allowed: false,
      category: 'terminal_lead',
      reason: "I can't keep AI replying to booked, completed, or archived leads. Terminal lead statuses stop AI replies by design.",
    };
  }
  if (PROMISE_PATTERNS.some(p => p.test(message))) {
    return {
      allowed: false,
      category: 'unsafe_promise',
      reason: "I can't add guarantees about exact availability or price without the required qualifying info. Those would be promises the AI can't honor.",
    };
  }
  return { allowed: true };
}

/**
 * Second-layer check against the LLM's proposed write. Refuses any
 * proposal whose newValue contains compliance-disabling instructions even
 * if the user message itself looked clean (jailbreak via roundabout
 * phrasing).
 */
export function checkProposedValueSafety(newValue: string): SafetyCheckResult {
  // Reuse the same patterns — they describe outcomes, not just phrasing,
  // so they catch both directions.
  return checkUserMessageSafety(newValue);
}
