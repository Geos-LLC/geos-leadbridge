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
  | 'opt_out'         // explicit unsubscribe / "stop messaging me" / "remove my info"
  | 'hired_elsewhere' // they got someone else / hired another company
  | 'completed'       // job done by us or another party — no longer needed
  | 'agreed'          // "book it" / "sounds good" — handoff to manager
  | 'deferring'       // "I'll get back to you" / "let me think" / "check with my husband"
  | 'asking'          // active question that needs an AI reply
  | 'engaged';        // continuing conversation, neither closing nor pausing

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

- deferring — Customer is pausing the conversation. Includes both vague pauses ("I'll get back to you", "let me think", "shopping around") AND time-bound pauses with explicit return windows ("back in 2 weeks", "I'll reach out next month", "I'm traveling, will be in touch when I'm home in 10 days"). A time-bound pause is STILL deferring even when the customer sounds engaged about returning — they're explicitly pausing the conversation NOW.

- asking — Customer is asking a question that needs an answer. Examples: "How much for 3 bed?", "What time can you come?", "Do you do windows?", "Are you insured?".

- engaged — Continuing conversation, providing info, or otherwise neither closing nor pausing. Default for ambiguous cases. Examples: "Yes 3 bedrooms", "It's a two-story", "Tomorrow at 2 works".

Rules:

1. Lean toward 'engaged' when ambiguous. False-positive on opt_out / hired_elsewhere / completed prematurely loses the customer. EXCEPTION: a clear time-bound pause ("back in 2 weeks", "next month", "after vacation") IS deferring even when the customer is otherwise positive — replying to it as if the conversation is live spams them during a window they explicitly closed.
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
      'opt_out', 'hired_elsewhere', 'completed', 'agreed', 'deferring', 'asking', 'engaged',
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
