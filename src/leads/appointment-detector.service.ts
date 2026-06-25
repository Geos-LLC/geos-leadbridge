/**
 * Appointment Detector
 *
 * Autonomous-mode helper. When LB is NOT connected to Service Flow, there is
 * no upstream system telling us "this lead is booked / done". The dispatcher
 * still types appointment confirmations directly in the Thumbtack inbox
 * ("Hi Lanita, your cleaning is scheduled for tomorrow June 25 between
 * 10-10:30 AM. Our cleaner will arrive on time..."). The Chrome extension
 * scrapes those messages back into LB, and this service decides whether such
 * a message is a true appointment confirmation that should park the lead in
 * `booked` and stop the follow-up engine.
 *
 * Two-stage pipeline:
 *   1. Cheap regex pre-filter: rejects messages that obviously aren't an
 *      appointment confirmation (no date + time + appointment keyword).
 *   2. LLM classifier (gpt-4o-mini): only invoked when the pre-filter passes.
 *      Returns `{confirmed, appointmentAt, slotMinutes, confidence}`.
 *
 * Why the two-stage shape: dispatcher inboxes are noisy — pricing quotes, FAQ
 * replies, "let me check and get back to you" all run through the same
 * message pipe. Calling the LLM on every outbound message would be wasteful
 * and add latency to every webhook. The regex catches the 95% of messages
 * that are nowhere near being a confirmation, and the LLM is the precise
 * arbiter for the remaining handful.
 *
 * The detector never writes to the DB itself — callers wire its output into
 * LeadStatusService.writeStatus with reason='dispatcher_confirmed'. Detection
 * is a pure read.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

export interface DetectInput {
  /** The dispatcher's outbound message text. */
  messageText: string;
  /** When the dispatcher sent the message — anchor for "tomorrow"/"next Tuesday". */
  messageSentAt: Date;
  /** IANA timezone for resolving relative dates. Default America/New_York. */
  timezone: string;
  /** Customer name, for the LLM to anchor "this conversation" vs "any conversation". */
  customerName?: string;
}

export interface DetectResult {
  /** True when the message confirms a specific upcoming appointment. */
  confirmed: boolean;
  /**
   * ISO datetime of the appointment slot start, in the supplied timezone
   * (carries the offset). Null when `confirmed=false` or the LLM couldn't
   * resolve a specific time.
   */
  appointmentAt: string | null;
  /**
   * Duration of the appointment slot in minutes. Defaults to 30 when the
   * dispatcher gave a single anchor time ("10 AM") rather than a range
   * ("10-10:30 AM"). Null when `confirmed=false`.
   */
  slotMinutes: number | null;
  /** LLM-reported confidence in [0,1]. We require ≥0.85 to act on a write. */
  confidence: number;
  /** Short reason string, for logs. */
  reason: string;
  /** True when the regex pre-filter rejected the message (LLM was skipped). */
  skippedByPrefilter: boolean;
}

export type PostJobSignalType = 'review_request' | 'receipt' | 'payment' | 'post_job_thanks';

export interface PostJobDetectResult {
  /** True when the dispatcher message is a strong "job is done" signal. */
  completed: boolean;
  /** Which type of post-job signal triggered detection. Null when completed=false. */
  signalType: PostJobSignalType | null;
  /** LLM-reported confidence in [0,1]. ≥0.85 required to act. */
  confidence: number;
  /** Short reason string, for logs. */
  reason: string;
  /** True when the regex pre-filter rejected the message (LLM was skipped). */
  skippedByPrefilter: boolean;
}

const PREFILTER_KEYWORDS = [
  'scheduled',
  'schedule',
  'appointment',
  'cleaning',
  'reminder',
  'confirm',
  'confirmed',
  'arrive',
  'arrival',
  'tomorrow',
  'see you',
  // 'clean' covers messages like "looking forward to helping you clean your
  // home on June 29 9-9:30 AM" where the dispatcher uses the verb form
  // instead of the gerund. False-positive risk is low — the LLM is the final
  // arbiter; the only cost is paying for a few more LLM calls per day.
  'clean',
  // Common confirmation phrasings that don't always include one of the other
  // keywords ("Looking forward to seeing you on the 25th at 10 AM").
  'looking forward',
  'be there',
  "we'll come",
  'we can come',
];

// Loose date tokens: "Jun 25", "June 25", "6/25", "06/25", "tomorrow",
// "next tuesday", weekday names. Intentionally over-eager — the LLM has the
// final say. We only need to filter out messages with no date-like content.
const DATE_RE = new RegExp(
  [
    '\\btomorrow\\b',
    '\\btonight\\b',
    '\\b(?:today|this (?:morning|afternoon|evening))\\b',
    '\\bnext (?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\b',
    '\\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\b',
    '\\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\b',
    '\\b\\d{1,2}[/\\-]\\d{1,2}(?:[/\\-]\\d{2,4})?\\b',
  ].join('|'),
  'i',
);

// Time tokens: "10 AM", "10:30 AM", "10-10:30 AM", "between 10 and 10:30",
// "at 14:00". Same philosophy — over-eager pre-filter.
const TIME_RE = new RegExp(
  [
    '\\b\\d{1,2}\\s*(?:am|pm)\\b',
    '\\b\\d{1,2}:\\d{2}\\s*(?:am|pm)?\\b',
    '\\bbetween\\s+\\d{1,2}\\b',
    '\\bat\\s+\\d{1,2}(?::\\d{2})?\\b',
  ].join('|'),
  'i',
);

// ── Post-job signal detection ────────────────────────────────────────────
// Some leads predate the LeadBridge integration: there's no record of an
// appointment confirmation, but the only dispatcher message we have is the
// review request that the tenant only sends AFTER a completed cleaning, or
// the receipt that Thumbtack issued at payment. Both are strong signals
// that the job is done — strong enough to mark the lead `completed` directly
// (skipping `booked`).
//
// Same two-stage pipeline as appointment detection: cheap regex pre-filter
// gates a small LLM call. False positives here downgrade an active lead to
// completed, which would stop follow-ups inappropriately, so the LLM is
// instructed to be strict.

const POST_JOB_KEYWORDS = [
  'review',
  'rating',
  'rate my',
  'feedback',
  'receipt',
  'paid',
  'payment',
  'invoice',
  'transaction',
  'thank you for choosing',
  'thank you for trusting',
  'great working with you',
  'pleasure cleaning',
];

const POST_JOB_SYSTEM_PROMPT = `You decide whether a dispatcher message is a POST-JOB signal — meaning the cleaning has already been completed.

Output strict JSON: {"completed": boolean, "signalType": "review_request" | "receipt" | "payment" | "post_job_thanks" | null, "confidence": number, "reason": string}

Rules:
1. completed=true ONLY when the message is one of these post-job signals:
   - REVIEW REQUEST: dispatcher asks the customer to leave a review / rating / feedback ("could you write a review", "I'd appreciate a review of my work", "rate my service").
   - RECEIPT / PAYMENT: dispatcher delivers a receipt / payment confirmation tied to a completed job ("here's your receipt for your cleaning", "payment received").
   - POST-JOB THANKS: dispatcher says "thank you for choosing us" / "great working with you" in a way that clearly references a finished job (not the initial intake "thank you for choosing us" auto-replies to a new lead).
2. completed=false when the message is:
   - A PRE-JOB confirmation ("looking forward to cleaning your home on June 29 9-9:30 AM") — that's a future appointment, not a completion.
   - A quote / qualification / pricing reply.
   - An initial "thank you for choosing us, let me check our schedule" intake auto-reply (these go out within minutes of a new lead).
   - A follow-up checking in ("are you still interested").
3. signalType: tag which signal triggered completion. Null when completed=false.
4. confidence: how certain you are. Be strict — borderline messages should score below 0.85.
5. reason: short (≤12 words) factual log line.`;

const SYSTEM_PROMPT = `You decide whether a dispatcher message is confirming a specific upcoming cleaning appointment for THIS customer.

Output strict JSON: {"confirmed": boolean, "appointmentAt": string|null, "slotMinutes": number|null, "confidence": number, "reason": string}

Rules:
1. confirmed=true ONLY when the message references BOTH:
   - a concrete future date (today/tomorrow/named day/explicit date)
   - a concrete time or time range
   AND the language is affirmative ("scheduled for", "your appointment is", "reminder that ... is at", "we'll be there at", "confirmed for"). A question like "does Tuesday work?" is NOT a confirmation.
2. appointmentAt must be a full ISO datetime in the SUPPLIED TIMEZONE offset. Resolve "tomorrow" / "next Tuesday" against the supplied messageSentAt + timezone. If you can't resolve a specific datetime, return confirmed=false.
3. slotMinutes: when the message gives a range ("10-10:30 AM"), use that. When it gives a single anchor time ("at 10 AM"), default 30. Null when confirmed=false.
4. confidence: how certain you are this is a real appointment confirmation. Be strict — borderline messages should score below 0.85 so the caller drops them.
5. reason: short (≤12 words) factual log line.
6. Skip rescheduling discussion ("can we move it to..."), quote messages ("the price would be..."), and FAQ replies.`;

@Injectable()
export class AppointmentDetectorService {
  private readonly logger = new Logger(AppointmentDetectorService.name);
  private _client: OpenAI | null = null;

  /** Confidence floor below which we treat the LLM as undecided. */
  static readonly MIN_CONFIDENCE = 0.85;

  constructor(private readonly configService: ConfigService) {}

  private get client(): OpenAI {
    if (!this._client) {
      const apiKey = this.configService.get<string>('OPENAI_API_KEY');
      if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
      this._client = new OpenAI({ apiKey });
    }
    return this._client;
  }

  /**
   * Cheap synchronous pre-filter. Returns `true` when the message has all the
   * surface features of an appointment confirmation (date token + time token
   * + keyword). The LLM only runs when this returns true.
   *
   * Exported as a static so the spec can exercise it directly.
   */
  static preFilter(messageText: string): boolean {
    if (!messageText) return false;
    const lower = messageText.toLowerCase();
    if (!PREFILTER_KEYWORDS.some((k) => lower.includes(k))) return false;
    if (!DATE_RE.test(messageText)) return false;
    if (!TIME_RE.test(messageText)) return false;
    return true;
  }

  /**
   * Post-job pre-filter — far simpler than the confirmation pre-filter
   * because post-job signals don't have to mention a date or time. Just one
   * of the keyword stems is enough.
   */
  static postJobPreFilter(messageText: string): boolean {
    if (!messageText) return false;
    const lower = messageText.toLowerCase();
    return POST_JOB_KEYWORDS.some((k) => lower.includes(k));
  }

  /**
   * Post-job signal detection. Pairs with `detect()` (appointment confirmation)
   * — callers typically run BOTH per message and pick the strongest signal.
   * Returns `completed=true` when the LLM is confident the message indicates
   * the cleaning is already done.
   *
   * Two-stage pipeline:
   *   1. Cheap pre-filter (any of the POST_JOB_KEYWORDS).
   *   2. LLM classifier with strict prompt — distinguishes review/receipt
   *      from intake auto-replies and pre-job confirmations.
   */
  async detectPostJobSignal(input: DetectInput): Promise<PostJobDetectResult> {
    const skipResult = (skippedByPrefilter: boolean, reason: string): PostJobDetectResult => ({
      completed: false,
      signalType: null,
      confidence: 0,
      reason,
      skippedByPrefilter,
    });

    if (!input.messageText || !input.messageText.trim()) {
      return skipResult(true, 'empty_message');
    }
    if (!AppointmentDetectorService.postJobPreFilter(input.messageText)) {
      return skipResult(true, 'prefilter_no_match');
    }

    const userPrompt = this.buildUserPrompt(input);
    try {
      const completion = await this.withTimeout(
        this.client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: POST_JOB_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 160,
          temperature: 0,
          response_format: { type: 'json_object' },
        }),
        5000,
      );
      const raw = completion.choices[0]?.message?.content?.trim();
      if (!raw) return skipResult(false, 'empty_llm_response');

      const parsed = JSON.parse(raw) as Partial<PostJobDetectResult>;
      const completed = parsed.completed === true;
      const confidence = typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0;
      const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
      const signalType = this.coercePostJobSignalType(parsed.signalType);

      if (!completed) {
        return { completed: false, signalType: null, confidence, reason: reason || 'llm_not_completed', skippedByPrefilter: false };
      }
      if (confidence < AppointmentDetectorService.MIN_CONFIDENCE) {
        return { completed: false, signalType, confidence, reason: 'low_confidence', skippedByPrefilter: false };
      }
      if (!signalType) {
        // LLM said completed but didn't pick a recognized signal type.
        // Better to drop than to write a status flip without a labeled cause.
        return { completed: false, signalType: null, confidence, reason: 'no_signal_type', skippedByPrefilter: false };
      }
      return { completed: true, signalType, confidence, reason: reason || 'post_job_signal', skippedByPrefilter: false };
    } catch (err: any) {
      this.logger.warn(`[appointment-detector] post-job LLM call failed: ${err?.message ?? err}`);
      return skipResult(false, `llm_error:${err?.message ?? 'unknown'}`);
    }
  }

  private coercePostJobSignalType(v: unknown): PostJobSignalType | null {
    if (typeof v !== 'string') return null;
    if (v === 'review_request' || v === 'receipt' || v === 'payment' || v === 'post_job_thanks') return v;
    return null;
  }

  async detect(input: DetectInput): Promise<DetectResult> {
    const skipResult = (skippedByPrefilter: boolean, reason: string): DetectResult => ({
      confirmed: false,
      appointmentAt: null,
      slotMinutes: null,
      confidence: 0,
      reason,
      skippedByPrefilter,
    });

    if (!input.messageText || !input.messageText.trim()) {
      return skipResult(true, 'empty_message');
    }
    if (!AppointmentDetectorService.preFilter(input.messageText)) {
      return skipResult(true, 'prefilter_no_match');
    }

    const userPrompt = this.buildUserPrompt(input);

    try {
      const completion = await this.withTimeout(
        this.client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 180,
          temperature: 0,
          response_format: { type: 'json_object' },
        }),
        5000,
      );
      const raw = completion.choices[0]?.message?.content?.trim();
      if (!raw) return skipResult(false, 'empty_llm_response');

      const parsed = JSON.parse(raw) as Partial<DetectResult>;
      const confirmed = parsed.confirmed === true;
      const confidence = typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0;
      const reason = typeof parsed.reason === 'string' ? parsed.reason : '';

      if (!confirmed) {
        return { confirmed: false, appointmentAt: null, slotMinutes: null, confidence, reason: reason || 'llm_not_confirmed', skippedByPrefilter: false };
      }

      const appointmentAt = this.coerceAppointmentAt(parsed.appointmentAt);
      const slotMinutes = this.coerceSlotMinutes(parsed.slotMinutes);
      if (!appointmentAt) {
        return { confirmed: false, appointmentAt: null, slotMinutes: null, confidence, reason: 'invalid_appointment_at', skippedByPrefilter: false };
      }
      if (confidence < AppointmentDetectorService.MIN_CONFIDENCE) {
        return { confirmed: false, appointmentAt, slotMinutes, confidence, reason: 'low_confidence', skippedByPrefilter: false };
      }
      return { confirmed: true, appointmentAt, slotMinutes, confidence, reason: reason || 'confirmed', skippedByPrefilter: false };
    } catch (err: any) {
      this.logger.warn(`[appointment-detector] LLM call failed: ${err?.message ?? err}`);
      return skipResult(false, `llm_error:${err?.message ?? 'unknown'}`);
    }
  }

  private buildUserPrompt(input: DetectInput): string {
    const lines = [
      `Timezone: ${input.timezone}`,
      `Message sent at: ${input.messageSentAt.toISOString()}`,
    ];
    if (input.customerName) lines.push(`Customer: ${input.customerName}`);
    lines.push('Dispatcher message:');
    lines.push(`  ${this.truncate(input.messageText, 1200)}`);
    return lines.join('\n');
  }

  private coerceAppointmentAt(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }

  private coerceSlotMinutes(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const rounded = Math.round(value);
    if (rounded < 5 || rounded > 480) return null;
    return rounded;
  }

  private truncate(s: string, n: number): string {
    if (!s) return '';
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`appointment-detector timeout after ${ms}ms`)), ms);
      promise.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); },
      );
    });
  }
}
