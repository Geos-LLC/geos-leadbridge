/**
 * Tests for the V2 Instant Text AI generator.
 *
 * Splits into two layers:
 *   1. SMS_FIRST_TOUCH_PROMPT contract — pins the rule set the spec called
 *      out (1-2 sentences, <240 chars, no bullets, no availability
 *      promises, no price unless asked, no AI self-disclosure).
 *   2. generateInstantTextBody behavior — verifies the service loads the
 *      right SavedAccount columns, passes the SMS strategy prompt to
 *      AiService.generateReply with the expected reference blocks, and
 *      collapses newlines on the returned body.
 *
 * Full end-to-end coverage of the "Instant Text fires AI then falls back
 * to template on failure" path lives in notifications.service.spec.ts —
 * the fallback contract is tested at the caller (sendNotificationWithRule)
 * where the INSTANT_TEXT_AI_FALLBACK_TEMPLATE log marker actually fires.
 */

import { InstantTextAiService, SMS_FIRST_TOUCH_PROMPT } from './instant-text-ai.service';

describe('SMS_FIRST_TOUCH_PROMPT — rule contract', () => {
  it('caps target length so the model produces a short SMS', () => {
    // Defensive: the model is mildly position-sensitive — the length cap
    // is in the MUST section, not buried in an example. Pin the literal
    // "240 characters" + "1 or 2 short sentences" so a careless edit can't
    // silently relax the cap.
    expect(SMS_FIRST_TOUCH_PROMPT).toMatch(/under\s+240\s+characters/i);
    expect(SMS_FIRST_TOUCH_PROMPT).toMatch(/1\s+or\s+2\s+short\s+sentences/i);
  });

  it('bans bullets, markdown, and lists', () => {
    expect(SMS_FIRST_TOUCH_PROMPT).toMatch(/no\s+bullets|bullets,?\s+numbered\s+lists/i);
    expect(SMS_FIRST_TOUCH_PROMPT.toLowerCase()).toContain('markdown');
  });

  it('bans availability promises (no "Thursday at 10am" style commitments)', () => {
    // "Promise availability or specific timing" — pin that phrase, since
    // the spec called it out explicitly + it's a frequent regression.
    expect(SMS_FIRST_TOUCH_PROMPT).toMatch(/availability/i);
    expect(SMS_FIRST_TOUCH_PROMPT).toMatch(/specific\s+timing/i);
  });

  it('forbids volunteering price unless the lead asked about price', () => {
    expect(SMS_FIRST_TOUCH_PROMPT).toMatch(/Volunteer\s+a\s+price\s+unless/i);
    expect(SMS_FIRST_TOUCH_PROMPT).toMatch(/asked\s+about\s+price.+cost.+quote.+budget/i);
  });

  it('forbids the AI from identifying as AI', () => {
    expect(SMS_FIRST_TOUCH_PROMPT).toMatch(/Identify\s+yourself\s+as\s+AI/i);
  });

  it('caps the AI to ONE question per SMS', () => {
    expect(SMS_FIRST_TOUCH_PROMPT).toMatch(/Ask\s+more\s+than\s+one\s+question/i);
  });

  it('forbids marketing-speak phrases that signal a bot', () => {
    expect(SMS_FIRST_TOUCH_PROMPT).toMatch(/marketing-speak|excited\s+to|look\s+forward\s+to/i);
  });

  it('forbids mentioning the marketplace name in the SMS body', () => {
    // Customers find "thanks for reaching out via Thumbtack" off-putting
    // when they already know which marketplace they used. The prompt
    // explicitly bans Thumbtack / Yelp name-drops.
    expect(SMS_FIRST_TOUCH_PROMPT).toMatch(/Mention\s+the\s+marketplace|Thumbtack\s*\/\s*Yelp/i);
  });

  it('contains the no-price and price-given example to anchor model behavior', () => {
    expect(SMS_FIRST_TOUCH_PROMPT.toLowerCase()).toContain('example (no price asked)');
    expect(SMS_FIRST_TOUCH_PROMPT.toLowerCase()).toContain('example (price asked)');
  });
});

describe('InstantTextAiService.generateInstantTextBody — context wiring', () => {
  function buildSvc(opts: {
    account?: any;
    user?: any;
    generateReplyResult?: string;
    generateReplyThrows?: Error;
  } = {}) {
    const findUniqueSavedAccount = jest.fn().mockResolvedValue(opts.account ?? {
      businessName: 'Test Co',
      servicePricingJson: null,
      faqJson: null,
      followUpSettingsJson: null,
      followUpTimezone: 'America/New_York',
      userId: 'user-1',
    });
    const findUniqueUser = jest.fn().mockResolvedValue(opts.user ?? {
      globalAiPrompt: null,
      name: 'Test Owner',
    });
    const prisma = {
      savedAccount: { findUnique: findUniqueSavedAccount },
      user: { findUnique: findUniqueUser },
    } as any;

    const generateReply = jest.fn();
    if (opts.generateReplyThrows) {
      generateReply.mockRejectedValue(opts.generateReplyThrows);
    } else {
      generateReply.mockResolvedValue(opts.generateReplyResult ?? 'Hi Sam — thanks for reaching out!');
    }
    const ai = { generateReply } as any;

    const svc = new InstantTextAiService(prisma, ai);
    return { svc, generateReply, findUniqueSavedAccount, findUniqueUser };
  }

  it('throws when SavedAccount is not found (caller falls back to template)', async () => {
    const { svc, findUniqueSavedAccount } = buildSvc();
    findUniqueSavedAccount.mockResolvedValueOnce(null);
    await expect(
      svc.generateInstantTextBody({
        savedAccountId: 'missing',
        customerName: 'Sam',
        customerMessage: 'I need cleaning',
      }),
    ).rejects.toThrow(/SavedAccount missing not found/);
  });

  it('passes SMS_FIRST_TOUCH_PROMPT as the strategyPrompt to AiService', async () => {
    const { svc, generateReply } = buildSvc();
    await svc.generateInstantTextBody({
      savedAccountId: 'sa-1',
      customerName: 'Sam',
      customerMessage: 'How much for a deep clean?',
    });
    expect(generateReply).toHaveBeenCalledTimes(1);
    const ctx = generateReply.mock.calls[0][0];
    expect(ctx.strategyPrompt).toBe(SMS_FIRST_TOUCH_PROMPT);
  });

  it('passes the lead message verbatim as customerMessage', async () => {
    const { svc, generateReply } = buildSvc();
    await svc.generateInstantTextBody({
      savedAccountId: 'sa-1',
      customerName: 'Sam',
      customerMessage: 'How much for a deep clean for 1800 sqft?',
      category: 'House Cleaning',
    });
    const ctx = generateReply.mock.calls[0][0];
    expect(ctx.customerMessage).toBe('How much for a deep clean for 1800 sqft?');
    expect(ctx.customerName).toBe('Sam');
    expect(ctx.category).toBe('House Cleaning');
  });

  it('passes empty conversationHistory — first-touch has no prior turns', async () => {
    const { svc, generateReply } = buildSvc();
    await svc.generateInstantTextBody({
      savedAccountId: 'sa-1',
      customerName: 'Sam',
      customerMessage: 'hi',
    });
    expect(generateReply.mock.calls[0][0].conversationHistory).toEqual([]);
  });

  it('passes a deterministic CALCULATED QUOTE block when pricing + rawJson + add-on mention all align', async () => {
    // Deterministic pricing engine wired into Instant Text (2026-06-13).
    // The block content is fully tested in src/pricing/*.spec.ts — here we
    // only pin the wiring: when SavedAccount has pricing JSON, the lead
    // rawJson has bed/bath, and the customer mentions a configured add-on,
    // the engine produces a "Calculated total" line and the service hands
    // it through as `quoteBlock` to AiService.generateReply.
    const pricingJson = JSON.stringify({
      cleaningTypes: [
        { key: 'regular', label: 'Regular', enabled: true },
        { key: 'deep', label: 'Deep', enabled: true },
      ],
      priceTable: [
        { bed: 3, bath: 2, sqftMin: 1300, sqftMax: 1600, regular: 159, deep: 219 },
      ],
      extras: [
        { key: 'fridge', label: 'Inside Fridge', price: 40 },
        { key: 'oven', label: 'Inside Oven', price: 40 },
      ],
    });
    const { svc, generateReply } = buildSvc({
      account: {
        businessName: 'Test',
        servicePricingJson: pricingJson,
        faqJson: null,
        followUpSettingsJson: null,
        followUpTimezone: null,
        userId: 'user-1',
      },
    });
    await svc.generateInstantTextBody({
      savedAccountId: 'sa-1',
      customerName: 'Sam',
      customerMessage: 'How much for a deep clean with inside the fridge and oven?',
      leadRawJson: JSON.stringify({ bedrooms: 3, bathrooms: 2, serviceType: 'Deep Clean' }),
    });
    const quoteBlock = generateReply.mock.calls[0][0].quoteBlock;
    expect(typeof quoteBlock).toBe('string');
    expect(quoteBlock).toContain('Calculated total: $299');
    expect(quoteBlock).toContain('Inside Fridge');
    expect(quoteBlock).toContain('Inside Oven');
    expect(quoteBlock).toMatch(/use these numbers verbatim/i);
  });

  it('emits clarification quoteBlock when leadRawJson is missing (no bed/bath)', async () => {
    // Spec: "If no history exists, pricing falls back to platform data only."
    // When platform data is also absent, the engine emits the
    // requiresClarification block so the LLM asks instead of guessing.
    const pricingJson = JSON.stringify({
      cleaningTypes: [{ key: 'regular', label: 'Regular', enabled: true }],
      priceTable: [{ bed: 3, bath: 2, regular: 159 }],
      extras: [],
    });
    const { svc, generateReply } = buildSvc({
      account: {
        businessName: 'Test',
        servicePricingJson: pricingJson,
        faqJson: null,
        followUpSettingsJson: null,
        followUpTimezone: null,
        userId: 'user-1',
      },
    });
    await svc.generateInstantTextBody({
      savedAccountId: 'sa-1',
      customerName: 'Sam',
      customerMessage: 'How much?',
    });
    const quoteBlock = generateReply.mock.calls[0][0].quoteBlock;
    expect(typeof quoteBlock).toBe('string');
    expect(quoteBlock).toMatch(/NOT been calculated/i);
    expect(quoteBlock).toContain('bedrooms');
  });

  it('passes the saved account globalAiPrompt when set', async () => {
    const { svc, generateReply } = buildSvc({
      user: { globalAiPrompt: 'Always sign off with "—Nadja"', name: 'Nadja' },
    });
    await svc.generateInstantTextBody({
      savedAccountId: 'sa-1',
      customerName: 'Sam',
      customerMessage: 'hi',
    });
    expect(generateReply.mock.calls[0][0].globalPrompt).toBe('Always sign off with "—Nadja"');
  });

  it('builds the canonical PRICING block (parsed rows + range/exact + guard rules) when the table is valid', async () => {
    // Same pipeline as automation.service / follow-up-generator. The raw
    // JSON dump that used to live here bypassed range/exact mode and the
    // FargiPro guard rules — that drift is closed. Under the 2026-06-13
    // source-of-truth fix the "Deep not offered" signal is no longer
    // `enabled: false` — it's `deep: 0` across every row. The guard
    // layer then emits the "do NOT quote, defer" clause for Deep.
    const pricingJson = JSON.stringify({
      cleaningTypes: [
        { key: 'regular', label: 'Regular', enabled: true },
        { key: 'deep', label: 'Deep', enabled: true },
      ],
      priceTable: [
        { bed: 2, bath: 1, sqftMin: 800, sqftMax: 1000, regular: 150, deep: 0 },
        { bed: 3, bath: 2, sqftMin: 1200, sqftMax: 1600, regular: 200, deep: 0 },
      ],
      sqftAdjustEnabled: true,
    });
    const { svc, generateReply } = buildSvc({
      account: {
        businessName: 'Test',
        servicePricingJson: pricingJson,
        faqJson: null,
        followUpSettingsJson: JSON.stringify({ priceQuoteMode: 'range' }),
        followUpTimezone: null,
        userId: 'user-1',
      },
    });
    await svc.generateInstantTextBody({
      savedAccountId: 'sa-1',
      customerName: 'Sam',
      customerMessage: 'how much',
    });
    const pricingBlock = generateReply.mock.calls[0][0].pricingBlock;
    expect(typeof pricingBlock).toBe('string');
    // Row formatting: all rows + both service columns render (including
    // Deep: $0, since the column always renders under the new rule).
    expect(pricingBlock).toContain('2BR/1BA');
    expect(pricingBlock).toContain('3BR/2BA');
    expect(pricingBlock).toContain('Regular: $150');
    expect(pricingBlock).toContain('Regular: $200');
    expect(pricingBlock).toContain('Deep: $0');
    // Range-mode quoting instruction (from buildPriceRangeInstruction)
    expect(pricingBlock).toMatch(/range/i);
    // Hard guard rules (from buildPricingGuardRules) — defer-on-unknown
    // AND defer-on-not-offered (Deep, since every row is 0).
    expect(pricingBlock.toLowerCase()).toContain('do not quote');
    expect(pricingBlock).toMatch(/does NOT currently offer[\s\S]*Deep/);
  });

  it('still emits pricingBlock when saved JSON omits cleaningTypes — hydration backfills the defaults', async () => {
    // Legacy regression case (the bug that started this refactor): saved
    // JSON has a priceTable but no cleaningTypes. Hydration now fills in
    // Regular/Deep/Airbnb from defaults, so the AI gets a real prompt
    // block instead of silently dropping it. The shape `{ rooms: ... }`
    // is unparseable as priceTable → block stays undefined; we also
    // verify the legacy-priceTable case below.
    const legacyButValid = JSON.stringify({
      priceTable: [{ bed: 2, bath: 1, regular: 150 }],
    });
    const { svc, generateReply } = buildSvc({
      account: {
        businessName: 'Test',
        servicePricingJson: legacyButValid,
        faqJson: null,
        followUpSettingsJson: null,
        followUpTimezone: null,
        userId: 'user-1',
      },
    });
    await svc.generateInstantTextBody({
      savedAccountId: 'sa-1',
      customerName: 'Sam',
      customerMessage: 'how much',
    });
    const pricingBlock = generateReply.mock.calls[0][0].pricingBlock;
    expect(typeof pricingBlock).toBe('string');
    expect(pricingBlock).toContain('2BR/1BA');
    expect(pricingBlock).toContain('Regular Cleaning: $150');
    // Default Deep + Airbnb backfilled from DEFAULT_CLEANING_PRICING (2/1 row).
    expect(pricingBlock).toContain('Moving / Deep Cleaning: $179');
    expect(pricingBlock).toContain('Airbnb Turnaround: $149');
  });

  it('passes the unified playbookBlock so BASE HARD RULES + Playbook V2 sections apply to first-touch SMS', async () => {
    // Unifies Instant Text with AI Conversation / Review Mode / Follow-ups.
    // The renderer always emits the two top-level headers and the 8 HOW
    // section labels — assert on those rather than any individual default,
    // which is intentionally tweakable.
    const { svc, generateReply } = buildSvc();
    await svc.generateInstantTextBody({
      savedAccountId: 'sa-1',
      customerName: 'Sam',
      customerMessage: 'hi',
    });
    const playbookBlock = generateReply.mock.calls[0][0].playbookBlock;
    expect(typeof playbookBlock).toBe('string');
    expect(playbookBlock).toContain('=== BASE HARD RULES');
    expect(playbookBlock).toContain('=== AI PLAYBOOK ===');
    // The 8 HOW section headers from PLAYBOOK_SECTION_LABELS
    expect(playbookBlock).toContain('[BUSINESS INFORMATION]');
    expect(playbookBlock).toContain('[PRICING GUIDANCE]');
    expect(playbookBlock).toContain('[QUALIFICATION GUIDANCE]');
    expect(playbookBlock).toContain('[BOOKING GUIDANCE]');
    expect(playbookBlock).toContain('[OBJECTION HANDLING]');
    expect(playbookBlock).toContain('[HUMAN HANDOFF GUIDANCE]');
    expect(playbookBlock).toContain('[FOLLOW-UP TONE]');
    expect(playbookBlock).toContain('[AI PERSONALITY & BRAND VOICE]');
  });

  it('reflects per-account Playbook V2 custom instructions in the playbookBlock', async () => {
    // Closes the original drift: a tenant who edits the brand-voice section
    // in Settings → AI Playbook used to see no effect on Instant Text SMS.
    const followUpSettingsJson = JSON.stringify({
      aiPlaybookV2: {
        personality_brand_voice: {
          customInstructions: 'Always sign off as "—The Spotless Team".',
        },
      },
    });
    const { svc, generateReply } = buildSvc({
      account: {
        businessName: 'Spotless',
        servicePricingJson: null,
        faqJson: null,
        followUpSettingsJson,
        followUpTimezone: null,
        userId: 'user-1',
      },
    });
    await svc.generateInstantTextBody({
      savedAccountId: 'sa-1',
      customerName: 'Sam',
      customerMessage: 'hi',
    });
    const playbookBlock = generateReply.mock.calls[0][0].playbookBlock;
    expect(playbookBlock).toContain('—The Spotless Team');
    expect(playbookBlock).toContain('Business preference (overrides default when they conflict):');
  });

  it('collapses internal newlines on the returned body so the SMS stays single-line', async () => {
    const { svc } = buildSvc({
      generateReplyResult: 'Hi Sam — thanks for reaching out.\n\nAbout how big is the home?',
    });
    const out = await svc.generateInstantTextBody({
      savedAccountId: 'sa-1',
      customerName: 'Sam',
      customerMessage: 'hi',
    });
    expect(out).toBe('Hi Sam — thanks for reaching out. About how big is the home?');
    expect(out).not.toContain('\n');
  });

  it('trims surrounding whitespace on the returned body', async () => {
    const { svc } = buildSvc({
      generateReplyResult: '   Hi Sam!   ',
    });
    const out = await svc.generateInstantTextBody({
      savedAccountId: 'sa-1',
      customerName: 'Sam',
      customerMessage: 'hi',
    });
    expect(out).toBe('Hi Sam!');
  });

  it('propagates AiService errors so the caller can fall back to template', async () => {
    const { svc } = buildSvc({
      generateReplyThrows: new Error('OpenAI 429 rate limited'),
    });
    await expect(
      svc.generateInstantTextBody({
        savedAccountId: 'sa-1',
        customerName: 'Sam',
        customerMessage: 'hi',
      }),
    ).rejects.toThrow(/OpenAI 429 rate limited/);
  });
});
