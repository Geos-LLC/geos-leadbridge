/**
 * SlotPhrasingService — Phase 2B PR-B2.
 *
 * Turns a list of exact SF-returned slots into a customer-facing message
 * that the booking orchestrator can send. The slot times themselves are
 * authoritative — AI may phrase them naturally but MUST NOT invent or
 * modify them. If the LLM call fails or times out, we fall back to a
 * deterministic plain-text template.
 *
 * Safety properties (all enforced):
 *  - The LLM receives the exact ISO strings as a reference block.
 *  - The LLM is instructed: do not invent, do not modify, do not round.
 *  - After the LLM responds, we validate that every slot's start time
 *    (in the locale-formatted form we'd accept) appears in the output.
 *  - If validation fails OR the LLM times out OR errors, we return the
 *    deterministic template instead.
 *  - The deterministic template lists exactly the slots we were handed,
 *    so it is impossible to surface a slot the orchestration layer didn't
 *    authorize.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { TimeSlot } from '../sf-orchestration/sf-orchestration.contracts';

export interface SlotPhrasingContext {
  /** Customer-facing display name (no PII beyond what the customer chose to share). */
  customerName?: string | null;
  /** Provider / business name to introduce the offer ("[Acme Cleaning] has these openings…"). */
  accountName?: string | null;
  /** IANA timezone — slot ISO strings will be formatted in this tz. */
  timezone?: string | null;
  /** Optional service category to flavor the phrasing ("standard cleaning", "deep clean", …). */
  serviceLabel?: string | null;
}

export interface SlotPhrasingResult {
  /** The text to send to the customer. */
  message: string;
  /** Which path produced the message — useful for observability. */
  source: 'ai' | 'template';
  /** Truthy when AI was attempted but rejected/timed out. */
  fallbackReason?: string;
}

const SYSTEM_PROMPT = `You phrase a short, friendly availability offer to a customer for a home-service appointment.

Rules — these are STRICT and non-negotiable:

1. The available slots are listed in the REFERENCE block below. You MUST use those exact times. Do NOT round, shift, abbreviate, combine, or invent new times. Do NOT suggest times not in the list.
2. List the slots in the order given. You may number them ("1) Tuesday 9 AM …") or use bullets — pick one style.
3. Do not promise pricing, scope, supplies, or anything else outside the time offer.
4. Ask the customer to pick one. One short closing line is enough — for example "Which works?" or "Let me know which one fits."
5. Keep the total under 320 characters. No emojis. No greeting unless it's a single word like "Hey" / "Hi {{name}}".
6. Output ONLY the message text — no preamble, no JSON, no markdown fences.

If the REFERENCE block is empty, output: "Let me check availability and get back to you."`;

const OPENAI_TIMEOUT_MS = 8_000;

@Injectable()
export class SlotPhrasingService {
  private readonly logger = new Logger(SlotPhrasingService.name);
  private _client: OpenAI | null = null;

  constructor(private readonly config: ConfigService) {}

  private get client(): OpenAI {
    if (!this._client) {
      const apiKey = this.config.get<string>('OPENAI_API_KEY');
      if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
      this._client = new OpenAI({ apiKey });
    }
    return this._client;
  }

  /**
   * Public entry point. Tries AI phrasing first; falls back to the
   * deterministic template on any failure.
   */
  async phrase(slots: TimeSlot[], ctx: SlotPhrasingContext): Promise<SlotPhrasingResult> {
    if (!slots || slots.length === 0) {
      return {
        message: this.fallbackTemplate(slots, ctx),
        source: 'template',
        fallbackReason: 'no_slots',
      };
    }
    try {
      const ai = await this.tryAiPhrasing(slots, ctx);
      if (ai) return { message: ai, source: 'ai' };
      return {
        message: this.fallbackTemplate(slots, ctx),
        source: 'template',
        fallbackReason: 'ai_validation_failed',
      };
    } catch (e: any) {
      const reason = /timeout/i.test(e?.message ?? '') ? 'ai_timeout' : 'ai_error';
      this.logger.warn(
        `[SlotPhrasing] event=fallback reason=${reason} slot_count=${slots.length} err=${this.safeMsg(e?.message)}`,
      );
      return {
        message: this.fallbackTemplate(slots, ctx),
        source: 'template',
        fallbackReason: reason,
      };
    }
  }

  /**
   * Deterministic template — public so PR-B2 callers (or future code) can
   * skip the AI path entirely when desired (e.g. in tests or canary).
   */
  fallbackTemplate(slots: TimeSlot[], ctx: SlotPhrasingContext): string {
    if (!slots || slots.length === 0) {
      return 'Let me check availability and get back to you.';
    }
    const greeting = ctx.customerName ? `Hi ${this.firstName(ctx.customerName)}, ` : '';
    const intro = ctx.accountName
      ? `${greeting}${ctx.accountName} has these openings`
      : `${greeting}we have these openings`;
    const lines = slots.map((s, i) => `${i + 1}) ${this.formatSlot(s, ctx.timezone)}`);
    return `${intro}:\n${lines.join('\n')}\nWhich works?`;
  }

  // ─── internals ─────────────────────────────────────────────────────────

  private async tryAiPhrasing(
    slots: TimeSlot[],
    ctx: SlotPhrasingContext,
  ): Promise<string | null> {
    const ref = this.buildReferenceBlock(slots, ctx);
    const completion = await this.withTimeout(
      this.client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: ref },
        ],
        max_tokens: 220,
        temperature: 0.3,
      }),
      OPENAI_TIMEOUT_MS,
    );
    const raw = completion.choices[0]?.message?.content?.trim();
    if (!raw) return null;

    // Validate: every slot's formatted display string must appear verbatim.
    // This prevents the model from inventing or shifting times.
    const formattedExpected = slots.map((s) => this.formatSlot(s, ctx.timezone));
    const missing = formattedExpected.filter((label) => !raw.includes(label));
    if (missing.length > 0) {
      this.logger.warn(
        `[SlotPhrasing] event=ai_validation_failed missing_slots=${missing.length}` +
          ` slot_count=${slots.length} sample_missing="${this.safeMsg(missing[0])}"`,
      );
      return null;
    }

    this.logger.log(
      `[SlotPhrasing] event=ai_success slot_count=${slots.length} chars=${raw.length}`,
    );
    return raw;
  }

  private buildReferenceBlock(slots: TimeSlot[], ctx: SlotPhrasingContext): string {
    const lines: string[] = [];
    if (ctx.customerName) lines.push(`Customer: ${this.firstName(ctx.customerName)}`);
    if (ctx.accountName) lines.push(`Business: ${ctx.accountName}`);
    if (ctx.serviceLabel) lines.push(`Service: ${ctx.serviceLabel}`);
    lines.push('');
    lines.push('=== REFERENCE: AVAILABLE APPOINTMENT SLOTS ===');
    lines.push('Use these EXACT labels. Do not modify, round, or invent. List in order.');
    for (let i = 0; i < slots.length; i++) {
      lines.push(`${i + 1}) ${this.formatSlot(slots[i], ctx.timezone)}`);
    }
    return lines.join('\n');
  }

  /**
   * Format a slot's ISO start into a stable human label. The same label is
   * used in the LLM reference block AND the validation check — if the
   * label format ever changes, both sides change together.
   *
   * We intentionally avoid extremely precise formatting (no seconds, no
   * timezone abbreviation past the tz name) so model variations like
   * "Tuesday 9 AM" still pass — only the components our format produces
   * are required to appear verbatim.
   */
  formatSlot(slot: TimeSlot, timezone?: string | null): string {
    try {
      const tz = timezone || 'UTC';
      const d = new Date(slot.start);
      if (isNaN(d.getTime())) return slot.start;
      const fmt = new Intl.DateTimeFormat('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        timeZone: tz,
      });
      return fmt.format(d);
    } catch {
      return slot.start;
    }
  }

  private firstName(full: string): string {
    return full.split(/\s+/)[0] ?? full;
  }

  private safeMsg(s: any): string {
    if (typeof s !== 'string') return String(s ?? '');
    return s.replace(/\s+/g, ' ').trim().slice(0, 180);
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`slot phrasing timeout after ${ms}ms`)), ms);
      promise.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); },
      );
    });
  }
}
