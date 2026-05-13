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
  | 'deferring'          // BOUNDED pause with intent to return: "back next week" / "let me think for a couple days" / "check with my husband"
  | 'terminal_defer'     // UNBOUNDED / indefinite deflection: "maybe later" / "someday" / "not now, hard to say" / "we'll see"
  | 'asking'             // active question that needs an AI reply
  | 'engaged';           // continuing conversation, neither closing nor pausing

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

Return JSON: {"intent": "...", "confidence": 0..1, "reason": "...", "suggestedReengageInDays": number|null}

Intents (pick exactly one):

- opt_out — Customer explicitly asks to stop being contacted, remove their info, or stop messaging. Examples: "stop", "unsubscribe", "leave me alone", "please lose my information", "delete my info", "remove me from your list". Also: explicit angry rejections of the SERVICE relationship ("never contact me again").

- hired_elsewhere — Customer got service from another provider. Examples: "I already hired someone else", "found a guy", "going with another company", "we booked someone else".

- completed — The work is done. Could be done by us or by another, the customer is signaling they no longer need anything. Examples: "It's already done, thanks", "all set", "all done", "taken care of already", "we don't need it anymore", "I sold the place / moved out".

- agreed — Customer accepts a proposal/quote and is ready to book. Examples: "sounds good", "let's do it", "book it", "yes please", "I'm in", "perfect, when can you come?". Active forward motion.

- wants_live_contact — Customer is requesting a live phone call, video call, Zoom, or in-person meeting at a specific time / soon. This is a high-intent handoff signal: they want a HUMAN, not a chat. Examples: "Can we talk by 6pm today?", "Let's hop on a call", "What's a good time to call you?", "Can you Zoom at 3?", "Give me a call when you're free", "I'd like to schedule a call", "Can we get on a call to discuss?", "what's your number — I want to call you", "would love to set up a meeting". Distinguish from 'asking' (where the customer is asking an information question that AI can answer in text). If the message is fundamentally "let's move this off chat onto a call/meeting", it's wants_live_contact.

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

Reason field: 8-15 words, factual. Used in logs.`;

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

      const daysBit = suggestedReengageInDays != null ? ` reengage_in=${suggestedReengageInDays}d` : '';
      this.logger.log(`[classifier] intent=${intent} conf=${confidence.toFixed(2)}${daysBit} reason="${reason}" msg="${this.truncate(ctx.message, 80)}"`);

      return { intent, confidence, reason, fromLlm: true, suggestedReengageInDays };
    } catch (err: any) {
      this.logger.warn(`[classifier] failed (${err.message}) — falling back to engaged for msg="${this.truncate(ctx.message, 80)}"`);
      return { intent: 'engaged', confidence: 0, reason: `classifier_failed: ${err.message}`, fromLlm: false };
    }
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
      'opt_out', 'hired_elsewhere', 'completed', 'agreed', 'wants_live_contact', 'deferring', 'terminal_defer', 'asking', 'engaged',
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
