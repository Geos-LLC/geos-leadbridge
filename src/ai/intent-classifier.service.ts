import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

/**
 * Customer-reply intent. The classifier returns one of these per inbound
 * customer message and the automation layer maps it to a lead-status
 * transition + AI Conversation skip decision.
 *
 * Why this exists: hardcoded phrase lists (OPT_OUT_PHRASES, HIRED_SOMEONE_PHRASES,
 * AGREED_PHRASES, deferral phrases) miss real customer phrasings. Donna said
 * "It's already done, thank you" — not in any list. Lynn said "Please lose my
 * information" — not in any list. The system kept harassing them. Whack-a-mole
 * on phrase lists is a losing game; let an LLM read the message instead.
 */
export type CustomerIntent =
  | 'opt_out'            // explicit unsubscribe / "stop messaging me" / "remove my info"
  | 'hired_elsewhere'    // they got someone else / hired another company
  | 'completed'          // job done by us or another party — no longer needed
  | 'agreed'             // "book it" / "sounds good" — handoff to manager
  | 'wants_live_contact' // customer wants a live call/meeting/Zoom — high-intent handoff signal
  | 'wants_to_schedule'  // customer is naming a specific time slot to book at — booking orchestrator entry (Phase 2B)
  | 'deferring'          // BOUNDED pause with intent to return: "back next week" / "let me think for a couple days" / "check with my husband"
  | 'terminal_defer'     // UNBOUNDED / indefinite deflection: "maybe later" / "someday" / "not now, hard to say" / "we'll see"
  | 'asking'             // active question that needs an AI reply
  | 'engaged';           // continuing conversation, neither closing nor pausing

/**
 * Distinct from CustomerIntent. A customer can be intent='engaged' AND
 * trigger a handoff because they just provided a phone number in the same
 * message. The two signals are orthogonal — intent drives the AI reply
 * decision, handoff drives the dispatcher SMS.
 */
export type HandoffReason =
  | 'agreed'
  | 'wants_live_contact'
  | 'provided_phone_number'
  | 'provided_square_footage'
  | 'qualification_complete';

export interface HandoffSignal {
  shouldHandoff: boolean;
  reason: HandoffReason;
  /**
   * Structured data the classifier pulled out of the message. Populated
   * opportunistically so future code (or future template variables) can
   * surface them. Today only used for logging.
   */
  extracted?: {
    phoneNumber?: string;
    squareFootage?: number;
    cleaningType?: string;
    bedrooms?: number;
    bathrooms?: number;
    preferredDateTime?: string;
  };
  /** Short rationale for logs and admin review. */
  explanation: string;
}

export interface IntentClassification {
  intent: CustomerIntent;
  confidence: number; // 0..1
  reason: string;     // short rationale for logging
  /** True if the classifier returned this; false if we fell back. */
  fromLlm: boolean;
  /**
   * Number of days the customer explicitly named as the pause/re-engage
   * window ("back in 2 weeks" → 14, "check back next month" → 30). Only
   * meaningful when intent is `deferring` / `hired_elsewhere` / `completed`.
   * Undefined when the customer didn't state a specific duration. Callers
   * use this to override the default first-step delay on a customer_deferred
   * or customer_hired_competitor enrollment.
   *
   * Bounded to [1, 180] in the parser so a model hallucination can't
   * schedule a follow-up years out.
   */
  suggestedReengageInDays?: number;
  /**
   * Handoff signal — orthogonal to intent. Present only when the classifier
   * detected a handoff-worthy event in the message (booking agreed, request
   * for a call, phone number shared, sq-ft provided, or qualification fully
   * answered). Consumed by automation.service.maybeFireHandoffAlert which
   * applies per-account trigger toggles + strategy gates before firing SMS.
   */
  handoff?: HandoffSignal;
}

export interface ClassifyContext {
  message: string;
  /** Last 3-5 turns. Older context goes stale; classifier only needs recent. */
  recentHistory?: { role: 'customer' | 'pro'; content: string }[];
  /** Current lead.status — "It's done" means different things at engaged vs booked. */
  leadStatus?: string;
  /** Lead category, e.g. "Deep cleaning". Helps disambiguate "all done". */
  leadCategory?: string;
}

const SYSTEM_PROMPT = `You classify a customer's reply to a service-business (cleaning, home services) lead conversation.

Return JSON:
{
  "intent": "...",
  "confidence": 0..1,
  "reason": "...",
  "suggestedReengageInDays": number|null,
  "handoff": { "shouldHandoff": boolean, "reason": "...", "extracted": {...}|null, "explanation": "..." } | null
}

Intents (pick exactly one):

- opt_out — Customer explicitly asks to stop being contacted, remove their info, or stop messaging. Examples: "stop", "unsubscribe", "leave me alone", "please lose my information", "delete my info", "remove me from your list". Also: explicit angry rejections of the SERVICE relationship ("never contact me again").

- hired_elsewhere — Customer got service from another provider. Examples: "I already hired someone else", "found a guy", "going with another company", "we booked someone else".

- completed — The work is done. Could be done by us or by another, the customer is signaling they no longer need anything. Examples: "It's already done, thanks", "all set", "all done", "taken care of already", "we don't need it anymore", "I sold the place / moved out".

- agreed — Customer accepts a proposal/quote and is ready to book. Examples: "sounds good", "let's do it", "book it", "yes please", "I'm in", "perfect, when can you come?". Active forward motion.

- wants_live_contact — Customer is requesting a live phone call, video call, Zoom, or in-person meeting WITH A HUMAN. This is a "move off chat onto a call" signal — NOT a booking signal. Examples: "Can we talk by 6pm today?", "Let's hop on a call", "What's a good time to call you?", "Can you Zoom at 3?", "Give me a call when you're free", "I'd like to schedule a call", "Can we get on a call to discuss?", "what's your number — I want to call you", "would love to set up a meeting". Distinguish from 'asking' (information question AI can answer in text). Distinguish from 'wants_to_schedule' (customer is picking a service appointment time, NOT requesting a live call with a human). If the message is fundamentally "let's move this off chat onto a call/meeting", it's wants_live_contact.

- wants_to_schedule — Customer is naming a specific service appointment time, picking from offered slots, or proposing a time for the SERVICE to happen. This is a booking-orchestrator signal: they want the cleaner/provider to come at a specific time. Examples: "I want Tuesday morning", "How about Friday at 2pm?", "Can you come tomorrow at 10?", "the 9am slot works", "I'll take Thursday", "what about next Wednesday 3pm", "let's do Saturday morning", "schedule me for the 11am one". Distinguish from 'agreed' (customer accepts an offer WITHOUT naming a specific time — "yes book it"). Distinguish from 'wants_live_contact' (wants a CALL with a human, not a service appointment). Distinguish from 'asking' ("what times do you have?" is asking, not picking). When the customer says BOTH "yes" AND a specific time ("yes Friday at 2pm works"), classify as 'agreed' — clean acceptance keeps the existing handoff path. wants_to_schedule fires when the customer is proposing/picking a time without clear acceptance language. ALSO set handoff.shouldHandoff=true with reason='agreed' on this intent when the customer's tone shows commitment ("I want", "let's do", "schedule me", "I'll take") so dispatchers are paged regardless of whether the booking orchestrator is enabled for the tenant.

- deferring — Customer is pausing the conversation BUT clearly intends to return, with either an explicit return window or a concrete decision-making step. Examples: "back in 2 weeks", "I'll reach out next month", "let me check with my husband and get back to you", "I'm traveling, will be in touch when I'm home in 10 days", "shopping around — will let you know by Friday". The pause is bounded by a stated time, a stated decision, or a clear come-back signal.

- terminal_defer — Customer is deflecting with NO intent to return, NO stated window, OR a window so far out it's effectively a soft no. This is "polite no". Examples: "maybe later", "someday", "not now, hard to say", "we'll see", "thanks but I'm going to think about it for a while", "not interested right now", "we'll keep your info on file, thanks". Distinguish from deferring by the ABSENCE of a return commitment — vague pauses without a stated window or decision are terminal_defer, not deferring.

- asking — Customer is asking a question that needs an answer. Examples: "How much for 3 bed?", "What time can you come?", "Do you do windows?", "Are you insured?".

- engaged — Continuing conversation, providing info, or otherwise neither closing nor pausing. Default for ambiguous cases. Examples: "Yes 3 bedrooms", "It's a two-story", "Tomorrow at 2 works".

Rules:

1. Lean toward 'engaged' when ambiguous. False-positive on opt_out / hired_elsewhere / completed prematurely loses the customer. EXCEPTIONS:
   - A clear time-bound pause ("back in 2 weeks", "next month", "after vacation") IS deferring even when the customer is otherwise positive — replying to it as if the conversation is live spams them during a window they explicitly closed.
   - A clear unbounded deflection ("maybe later", "we'll see", "going to think about it for a while" with NO return window) IS terminal_defer — keeping the conversation alive against an indefinite punt is the same anti-pattern, just slower-burning.
2. **Bounded vs unbounded** — the deferring/terminal_defer split is the single most important call you make. If the message names a duration ("2 weeks"), a decision ("when I check with my partner"), or a concrete future event ("after my move"), it's deferring. If it gives vague time ("maybe", "someday", "soon-ish", "later") or no time at all ("we'll see", "thanks for the info"), it's terminal_defer. When unsure, prefer terminal_defer — over-pausing engaged customers is reversible (they reply); under-pausing politely-declining customers is creepy follow-up.
2. Confidence ≥ 0.85 only when the message is unambiguous. Borderline → 0.5–0.7.
3. Bare "thanks" / "thank you" / "ok" / "got it" by itself, especially after the AI's last message was a farewell or holding statement, is 'completed' (the conversation is naturally winding down). When it follows an AI question like "what day works?", it's 'engaged'.
4. Cancellation phrases ("cancel that", "we can cancel") with context that a job exists → 'completed'. Cancellation as a question ("can I cancel my morning slot to switch to afternoon?") → 'engaged' — they want to reschedule, not stop.
5. Lead status context matters. If status = 'booked', "it's done" likely means the booked job ran successfully (still 'completed' — no further action needed). If status = 'engaged' or 'contacted', "it's done" means they got service elsewhere ('completed').
6. "Please lose my information" / "delete my info" / "remove my info" — opt_out, high confidence. The customer is explicitly invoking data-removal language.
7. Never classify based on customer sentiment alone (frustration, terseness). Only on what they're asking for or stating.

suggestedReengageInDays:
- ONLY set this when intent is 'deferring', 'hired_elsewhere', or 'completed' AND the customer's message contains an explicit duration or return window.
- Convert to whole days: "in 2 weeks" → 14, "next month" / "in a month" → 30, "next week" → 7, "in 10 days" → 10, "tomorrow" → 1, "later this year" / vague → null.
- Use null when no explicit duration is mentioned. Do NOT guess.
- Cap at 180 days. Anything longer → 180.
- This is the customer's stated re-engagement window; the system uses it to schedule the next outreach instead of the configured default cadence.

handoff field (independent of intent above — return null when nothing applies):

A customer can be intent='engaged' AND simultaneously trigger a handoff (e.g. answering a question while also sharing their phone number). Inspect the LATEST customer message for any of these signals and pick the single most actionable reason. Set handoff.shouldHandoff=true only when you see clear, dispatcher-worthy evidence; otherwise return handoff: null.

Allowed handoff.reason values (priority order — pick the highest one that applies):
1. "agreed" — same trigger as intent='agreed'. Customer accepted the quote / booking.
2. "wants_live_contact" — same trigger as intent='wants_live_contact'. Customer wants a call/meeting now.
3. "qualification_complete" — customer answered enough booking/pricing questions that the dispatcher can act. Heuristic: the message (combined with what's already in recent history) contains at least THREE of {cleaning type, bedrooms, bathrooms, square footage, frequency, preferred date/time}. Examples that fire: "Move-out cleaning, 2 bedrooms, 1 bathroom, about 900 sqft, Friday works", "Standard cleaning, 4 bed 3 bath, every two weeks". Do NOT fire on a single partial answer.
4. "provided_phone_number" — customer shared a phone number in this message. Extract digits to extracted.phoneNumber as a plain string. Examples: "My number is 248-555-1234", "Call me at 313 555 9911". Do NOT fire when they're ASKING about a phone number ("do you have a number?", "what's your number?") — that's a question, not a hand-off.
5. "provided_square_footage" — customer mentioned home/space size in sq ft. Extract digits to extracted.squareFootage as a number (e.g. "2,100 sq ft" → 2100). Examples: "about 2100 sq ft", "the house is 1800 square feet", "around 950 sqft".

extracted (object, all fields optional — return null on the parent when nothing extracted):
- phoneNumber: digits as a single string when reason is provided_phone_number.
- squareFootage: integer sqft when reason is provided_square_footage OR mentioned alongside qualification_complete.
- cleaningType / bedrooms / bathrooms / preferredDateTime: populate when the customer named them, especially for qualification_complete.

explanation: 6-12 words describing why this reason was picked. Used for logs.

Reason field (top-level): 8-15 words, factual. Used in logs.`;

@Injectable()
export class IntentClassifierService {
  private readonly logger = new Logger(IntentClassifierService.name);
  private _client: OpenAI | null = null;

  constructor(private readonly configService: ConfigService) {}

  private get client(): OpenAI {
    if (!this._client) {
      const apiKey = this.configService.get<string>('OPENAI_API_KEY');
      if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
      this._client = new OpenAI({ apiKey });
    }
    return this._client;
  }

  async classify(ctx: ClassifyContext): Promise<IntentClassification> {
    const userPrompt = this.buildUserPrompt(ctx);

    try {
      const completion = await this.withTimeout(
        this.client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 120,
          temperature: 0,
          response_format: { type: 'json_object' },
        }),
        5000,
      );

      const raw = completion.choices[0]?.message?.content?.trim();
      if (!raw) throw new Error('empty classifier response');

      const parsed = JSON.parse(raw) as Partial<IntentClassification>;
      const intent = this.coerceIntent(parsed.intent);
      if (!intent) throw new Error(`unrecognized intent: ${parsed.intent}`);

      const confidence = typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0;
      const reason = typeof parsed.reason === 'string' ? parsed.reason : '';

      // suggestedReengageInDays — only honored on pause/loss intents, bounded
      // to [1, 180] so a model hallucination can't schedule a follow-up
      // years out. The model is instructed to return null when no explicit
      // duration is mentioned. Defensive: 0 / negative / non-finite values
      // are treated as "unset" rather than coerced to 1, since "now-ish" is
      // not a meaningful re-engage window.
      let suggestedReengageInDays: number | undefined;
      const rawDays = (parsed as any).suggestedReengageInDays;
      if (typeof rawDays === 'number' && Number.isFinite(rawDays) && rawDays >= 1
          && (intent === 'deferring' || intent === 'hired_elsewhere' || intent === 'completed')) {
        suggestedReengageInDays = Math.round(Math.min(180, rawDays));
      }
      // Note: terminal_defer is intentionally excluded from suggestedReengageInDays
      // — by definition the customer didn't commit to a return window. The gate
      // treats terminal_defer as stop_and_lost (per follow-up-gate.service.ts);
      // there's no auto-re-engage to schedule.

      // Handoff signal — orthogonal to intent. Optional; absent or malformed
      // payloads fall through to undefined so callers can treat it as
      // "no handoff signaled" without a separate flag.
      let handoff: HandoffSignal | undefined;
      const rawHandoff: any = (parsed as any).handoff;
      if (rawHandoff && typeof rawHandoff === 'object' && rawHandoff.shouldHandoff === true) {
        const reasonOk = this.coerceHandoffReason(rawHandoff.reason);
        if (reasonOk) {
          const extractedIn = (rawHandoff.extracted && typeof rawHandoff.extracted === 'object')
            ? rawHandoff.extracted : null;
          const extracted: HandoffSignal['extracted'] | undefined = extractedIn ? {
            phoneNumber: typeof extractedIn.phoneNumber === 'string' ? extractedIn.phoneNumber.trim() : undefined,
            squareFootage: typeof extractedIn.squareFootage === 'number' && Number.isFinite(extractedIn.squareFootage)
              ? Math.round(extractedIn.squareFootage) : undefined,
            cleaningType: typeof extractedIn.cleaningType === 'string' ? extractedIn.cleaningType.trim() : undefined,
            bedrooms: typeof extractedIn.bedrooms === 'number' && Number.isFinite(extractedIn.bedrooms)
              ? Math.round(extractedIn.bedrooms) : undefined,
            bathrooms: typeof extractedIn.bathrooms === 'number' && Number.isFinite(extractedIn.bathrooms)
              ? Math.round(extractedIn.bathrooms) : undefined,
            preferredDateTime: typeof extractedIn.preferredDateTime === 'string'
              ? extractedIn.preferredDateTime.trim() : undefined,
          } : undefined;
          const explanation = typeof rawHandoff.explanation === 'string' ? rawHandoff.explanation : '';
          handoff = { shouldHandoff: true, reason: reasonOk, extracted, explanation };
        }
      }

      const daysBit = suggestedReengageInDays != null ? ` reengage_in=${suggestedReengageInDays}d` : '';
      const handoffBit = handoff ? ` handoff=${handoff.reason}` : '';
      this.logger.log(`[classifier] intent=${intent} conf=${confidence.toFixed(2)}${daysBit}${handoffBit} reason="${reason}" msg="${this.truncate(ctx.message, 80)}"`);

      return { intent, confidence, reason, fromLlm: true, suggestedReengageInDays, handoff };
    } catch (err: any) {
      this.logger.warn(`[classifier] failed (${err.message}) — falling back to engaged for msg="${this.truncate(ctx.message, 80)}"`);
      return { intent: 'engaged', confidence: 0, reason: `classifier_failed: ${err.message}`, fromLlm: false };
    }
  }

  private coerceHandoffReason(value: unknown): HandoffReason | null {
    const allowed: HandoffReason[] = [
      'agreed', 'wants_live_contact',
      'provided_phone_number', 'provided_square_footage', 'qualification_complete',
    ];
    if (typeof value !== 'string') return null;
    return (allowed as string[]).includes(value) ? (value as HandoffReason) : null;
  }

  private buildUserPrompt(ctx: ClassifyContext): string {
    const parts: string[] = [];
    if (ctx.leadStatus) parts.push(`Current lead status: ${ctx.leadStatus}`);
    if (ctx.leadCategory) parts.push(`Service: ${ctx.leadCategory}`);
    if (ctx.recentHistory && ctx.recentHistory.length > 0) {
      parts.push('Recent conversation (oldest first):');
      for (const m of ctx.recentHistory.slice(-5)) {
        const speaker = m.role === 'customer' ? 'Customer' : 'Business';
        parts.push(`  ${speaker}: ${this.truncate(m.content, 200)}`);
      }
    }
    parts.push('Message to classify:');
    parts.push(`  Customer: ${ctx.message}`);
    return parts.join('\n');
  }

  private coerceIntent(value: unknown): CustomerIntent | null {
    const allowed: CustomerIntent[] = [
      'opt_out', 'hired_elsewhere', 'completed', 'agreed', 'wants_live_contact', 'wants_to_schedule', 'deferring', 'terminal_defer', 'asking', 'engaged',
    ];
    if (typeof value !== 'string') return null;
    return (allowed as string[]).includes(value) ? (value as CustomerIntent) : null;
  }

  private truncate(s: string, n: number): string {
    if (!s) return '';
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`classifier timeout after ${ms}ms`)), ms);
      promise.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); },
      );
    });
  }
}
