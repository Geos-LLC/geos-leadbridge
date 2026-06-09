import {
  renderPlaybookBlock,
  previewPlaybookCategories,
  humanizeDelay,
  CATEGORY_ORDER,
  CATEGORY_DISPLAY_LABELS,
  type RawSavedAccount,
  type PlaybookInstructionsBlob,
} from './playbook-renderer';

function makeAccount(opts: {
  aiConversationMode?: 'always' | 'when_dispatcher_unavailable' | null;
  settings?: Record<string, unknown>;
  pricingTableRows?: number;
  noPricingJson?: boolean;
}): RawSavedAccount {
  const followUpSettingsJson = opts.settings === undefined ? null : JSON.stringify(opts.settings);
  let servicePricingJson: string | null = null;
  if (!opts.noPricingJson) {
    const rows = Array.from({ length: opts.pricingTableRows ?? 0 }, (_, i) => ({ bed: 2, bath: 1, sqft: 1000 + i }));
    servicePricingJson = JSON.stringify({ priceTable: rows });
  }
  return {
    aiConversationMode: opts.aiConversationMode === undefined ? 'when_dispatcher_unavailable' : opts.aiConversationMode,
    followUpSettingsJson,
    servicePricingJson,
  };
}

describe('humanizeDelay', () => {
  it('formats hours/days/weeks correctly with singular/plural', () => {
    expect(humanizeDelay('1h')).toBe('1 hour');
    expect(humanizeDelay('4h')).toBe('4 hours');
    expect(humanizeDelay('1d')).toBe('1 day');
    expect(humanizeDelay('3d')).toBe('3 days');
    expect(humanizeDelay('21d')).toBe('21 days');
    expect(humanizeDelay('1w')).toBe('1 week');
    expect(humanizeDelay('2w')).toBe('2 weeks');
  });
  it('falls back to the literal string on unrecognized format', () => {
    expect(humanizeDelay('weird')).toBe('weird');
    expect(humanizeDelay('')).toBe('');
    expect(humanizeDelay('5m')).toBe('5m');
  });
});

describe('renderPlaybookBlock — defaults', () => {
  it('renders all 8 categories with default bullets when settings are empty', () => {
    const block = renderPlaybookBlock(makeAccount({ settings: {}, pricingTableRows: 12 }));
    // All 8 category headers present, in order
    for (const cat of CATEGORY_ORDER) {
      expect(block).toContain(`[${CATEGORY_DISPLAY_LABELS[cat]}]`);
    }
    // Block prefixed with section header
    expect(block.startsWith('=== PLAYBOOK ===\n')).toBe(true);
    // No "Instructions:" anywhere (user has not edited any)
    expect(block).not.toContain('Instructions:');
  });

  it('produces the same defaults when followUpSettingsJson is null vs empty object', () => {
    const a = renderPlaybookBlock(makeAccount({ settings: undefined, pricingTableRows: 0 }));
    const b = renderPlaybookBlock(makeAccount({ settings: {}, pricingTableRows: 0 }));
    expect(a).toBe(b);
  });

  it('produces defaults when followUpSettingsJson contains invalid JSON', () => {
    const acc: RawSavedAccount = {
      aiConversationMode: 'when_dispatcher_unavailable',
      followUpSettingsJson: '{not valid json',
      servicePricingJson: null,
    };
    const block = renderPlaybookBlock(acc);
    // Should still render all categories without throwing
    for (const cat of CATEGORY_ORDER) {
      expect(block).toContain(`[${CATEGORY_DISPLAY_LABELS[cat]}]`);
    }
  });
});

describe('renderPlaybookBlock — Booking Requests', () => {
  it('includes all three default bullets when toggles are ON (default)', () => {
    const block = renderPlaybookBlock(makeAccount({ settings: {} }));
    expect(block).toContain('Notify the team when the customer is ready to book.');
    expect(block).toContain('Pause AI when the customer agrees on price or asks to book.');
    expect(block).toContain('Stop AI when the job is booked or confirmed.');
  });

  it('omits "notify" bullet when handoffTriggerAgreed=false', () => {
    const block = renderPlaybookBlock(makeAccount({
      settings: { handoffTriggerAgreed: false },
    }));
    expect(block).not.toContain('Notify the team when the customer is ready to book.');
    // Other booking bullets still present
    expect(block).toContain('Stop AI when the job is booked or confirmed.');
  });

  it('omits "pause" bullet when aiStopOnPriceAgreed=false (and it disappears from Human Contact too)', () => {
    const block = renderPlaybookBlock(makeAccount({
      settings: { aiStopOnPriceAgreed: false },
    }));
    expect(block).not.toContain('Pause AI when the customer agrees on price or asks to book.');
    expect(block).not.toContain('Pause AI when the customer asks for a person.');
  });
});

describe('renderPlaybookBlock — Human Contact (mirrored aiStopOnPriceAgreed)', () => {
  it('renders both Booking and Human Contact pause bullets when toggle is ON (mirrored key)', () => {
    const block = renderPlaybookBlock(makeAccount({ settings: { aiStopOnPriceAgreed: true } }));
    expect(block).toContain('Pause AI when the customer agrees on price or asks to book.');
    expect(block).toContain('Pause AI when the customer asks for a person.');
  });

  it('omits the Wants Live Contact bullet when handoffTriggerWantsLiveContact=false', () => {
    const block = renderPlaybookBlock(makeAccount({
      settings: { handoffTriggerWantsLiveContact: false },
    }));
    expect(block).not.toContain('Notify the team when the customer asks to speak to a person.');
  });
});

describe('renderPlaybookBlock — Pricing', () => {
  it('uses "lead with a price range" when strategy=price', () => {
    const block = renderPlaybookBlock(makeAccount({
      settings: { followUpStrategy: 'price' }, pricingTableRows: 5,
    }));
    expect(block).toContain('Lead with a price range proactively.');
  });

  it('uses "never volunteer a price" when strategy=qualify', () => {
    const block = renderPlaybookBlock(makeAccount({
      settings: { followUpStrategy: 'qualify' }, pricingTableRows: 5,
    }));
    expect(block).toContain('Never volunteer a price — qualify the lead first.');
  });

  it('uses "only quote when asked" for auto/hybrid/convert/phone', () => {
    for (const strat of ['auto', 'hybrid', 'convert', 'phone']) {
      const block = renderPlaybookBlock(makeAccount({
        settings: { followUpStrategy: strat }, pricingTableRows: 5,
      }));
      expect(block).toContain('Only quote a price when the customer asks about it.');
    }
  });

  it('reflects priceQuoteMode (range vs exact)', () => {
    const rangeBlock = renderPlaybookBlock(makeAccount({ settings: { priceQuoteMode: 'range' }, pricingTableRows: 5 }));
    expect(rangeBlock).toContain('Quote a price range; dispatcher confirms the exact number.');

    const exactBlock = renderPlaybookBlock(makeAccount({ settings: { priceQuoteMode: 'exact' }, pricingTableRows: 5 }));
    expect(exactBlock).toContain('Quote an exact price when the pricing table has enough information.');
  });

  it('mentions pricing table size when configured', () => {
    const block = renderPlaybookBlock(makeAccount({ settings: {}, pricingTableRows: 7 }));
    expect(block).toContain('Pricing table has 7 configured size/scope combinations.');
  });

  it('notes when no pricing table is configured', () => {
    const block = renderPlaybookBlock(makeAccount({ settings: {}, noPricingJson: true }));
    expect(block).toContain('No pricing table configured — AI cannot quote concrete numbers.');
  });

  it('always includes the dispatcher-confirms compliance bullet', () => {
    const block = renderPlaybookBlock(makeAccount({ settings: {}, pricingTableRows: 5 }));
    expect(block).toContain('Dispatcher confirms final pricing before booking is locked.');
  });
});

describe('renderPlaybookBlock — Customer Defers', () => {
  it('renders defer bullets with humanized delay when aiDeferralCheckIn=true (default)', () => {
    const block = renderPlaybookBlock(makeAccount({ settings: { aiDeferralDelay: '3d' } }));
    expect(block).toContain('Pause AI and check in again in 3 days.');
    expect(block).toContain('Send a re-engagement message at that time.');
  });

  it('omits the entire section when aiDeferralCheckIn=false AND no user instructions', () => {
    const block = renderPlaybookBlock(makeAccount({ settings: { aiDeferralCheckIn: false } }));
    expect(block).not.toContain('[CUSTOMER DEFERS]');
  });

  it('keeps the section header when user instructions are non-empty but toggle is off', () => {
    const settings: Record<string, unknown> = {
      aiDeferralCheckIn: false,
      aiPlaybookInstructions: { customer_defers: 'When customer says "let me think", say "Take your time."' },
    };
    const block = renderPlaybookBlock(makeAccount({ settings }));
    expect(block).toContain('[CUSTOMER DEFERS]');
    expect(block).toContain('Take your time');
    // No "Current behavior:" since bullets are empty
    const deferSection = block.split('[CUSTOMER DEFERS]')[1].split('[')[0];
    expect(deferSection).not.toContain('Current behavior:');
  });
});

describe('renderPlaybookBlock — Hired Another (re-engage delay)', () => {
  it('humanizes 21d as "21 days"', () => {
    const block = renderPlaybookBlock(makeAccount({
      settings: { aiHiredCompetitorDelay: '21d' },
    }));
    expect(block).toContain('Try re-engaging in 21 days');
  });

  it('omits the re-engage bullet when aiHiredCompetitorReengage=false but keeps the lost-marker', () => {
    const block = renderPlaybookBlock(makeAccount({
      settings: { aiHiredCompetitorReengage: false },
    }));
    expect(block).not.toContain('Try re-engaging in');
    expect(block).toContain('Mark the lead as lost (reason: hired elsewhere).');
  });
});

describe('renderPlaybookBlock — Opt-Out compliance', () => {
  it('always renders compliance bullets even when aiStopOnOptOut=false', () => {
    const block = renderPlaybookBlock(makeAccount({
      settings: { aiStopOnOptOut: false },
    }));
    expect(block).not.toContain('Stop AI when the customer asks not to be contacted.');
    // Compliance lines stay regardless of toggle state
    expect(block).toContain('Mark the lead as lost (reason: opt-out).');
    expect(block).toContain('Do not contact again.');
  });
});

describe('renderPlaybookBlock — Key Details', () => {
  it('renders all three notify bullets by default', () => {
    const block = renderPlaybookBlock(makeAccount({ settings: {} }));
    expect(block).toContain('Notify the team when the customer shares a phone number.');
    expect(block).toContain('Notify the team when the customer shares the home size (sqft).');
    expect(block).toContain('Notify the team when enough details are collected to quote.');
  });

  it('omits each bullet individually when the corresponding handoff trigger is off', () => {
    const block = renderPlaybookBlock(makeAccount({
      settings: {
        handoffTriggerProvidedPhone: false,
        handoffTriggerProvidedSquareFootage: true,
        handoffTriggerQualificationComplete: false,
      },
    }));
    expect(block).not.toContain('Notify the team when the customer shares a phone number.');
    expect(block).toContain('Notify the team when the customer shares the home size (sqft).');
    expect(block).not.toContain('Notify the team when enough details are collected to quote.');
  });
});

describe('renderPlaybookBlock — General AI Behavior', () => {
  it('reflects strategy=auto by default', () => {
    const block = renderPlaybookBlock(makeAccount({ settings: {} }));
    expect(block).toContain('Writing style: AI picks the best approach for each reply.');
  });

  it('reflects strategy=qualify when configured', () => {
    const block = renderPlaybookBlock(makeAccount({ settings: { followUpStrategy: 'qualify' } }));
    expect(block).toContain('Writing style: ask qualifying questions; never volunteer price.');
  });

  it('reflects availability when aiConversationMode=always', () => {
    const block = renderPlaybookBlock(makeAccount({ aiConversationMode: 'always' }));
    expect(block).toContain('Reply at any time of day.');
  });

  it('reflects availability when aiConversationMode=when_dispatcher_unavailable', () => {
    const block = renderPlaybookBlock(makeAccount({ aiConversationMode: 'when_dispatcher_unavailable' }));
    expect(block).toContain('Reply only outside business hours; humans handle daytime.');
  });
});

describe('renderPlaybookBlock — User instructions', () => {
  it('appends "Instructions:" block when category has user-edited text', () => {
    const instructions: PlaybookInstructionsBlob = {
      pricing: 'Ask for budget first when the customer says "too expensive".',
    };
    const block = renderPlaybookBlock(makeAccount({
      settings: { aiPlaybookInstructions: instructions }, pricingTableRows: 5,
    }));
    expect(block).toContain('Instructions:');
    expect(block).toContain('Ask for budget first when the customer says "too expensive".');
  });

  it('treats whitespace-only instructions as empty and omits the Instructions section', () => {
    const instructions: PlaybookInstructionsBlob = { pricing: '   \n   ' };
    const block = renderPlaybookBlock(makeAccount({
      settings: { aiPlaybookInstructions: instructions }, pricingTableRows: 5,
    }));
    // PRICING header present (because behavior summary has bullets), but no instructions section
    expect(block).toContain('[PRICING]');
    const pricingSection = block.split('[PRICING]')[1].split('[')[0];
    expect(pricingSection).not.toContain('Instructions:');
  });

  it('ignores non-string instructions values defensively', () => {
    const settings = {
      aiPlaybookInstructions: { pricing: 12345 as unknown as string },
    };
    const block = renderPlaybookBlock(makeAccount({ settings, pricingTableRows: 5 }));
    // Number is not a valid string, so it falls through `.trim()` after coercion;
    // the block should still render without throwing.
    expect(block).toContain('[PRICING]');
  });
});

describe('renderPlaybookBlock — empty + edge cases', () => {
  it('returns empty string when every category produces zero bullets and zero instructions', () => {
    const settings = {
      // Turn off every gate-driven bullet
      handoffTriggerAgreed: false,
      handoffTriggerWantsLiveContact: false,
      handoffTriggerProvidedPhone: false,
      handoffTriggerProvidedSquareFootage: false,
      handoffTriggerQualificationComplete: false,
      aiStopOnOptOut: false, // compliance bullets still render — so opt_out section will appear
      aiStopOnBooked: false,
      aiStopOnPriceAgreed: false,
      aiDeferralCheckIn: false,
      aiHiredCompetitorReengage: false,
      followUpStrategy: 'auto',
    };
    const block = renderPlaybookBlock(makeAccount({ settings, noPricingJson: true }));
    // Opt-out compliance + Pricing + General Behavior + Hired (mark-as-lost) bullets are hardcoded → block is NOT empty
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain('[OPT-OUT]');
    expect(block).toContain('[PRICING]');
    expect(block).toContain('[GENERAL AI BEHAVIOR]');
    expect(block).toContain('[HIRED ANOTHER COMPANY]');
  });

  it('emits the `=== PLAYBOOK ===` header only once', () => {
    const block = renderPlaybookBlock(makeAccount({ settings: {}, pricingTableRows: 3 }));
    const headerCount = (block.match(/=== PLAYBOOK ===/g) ?? []).length;
    expect(headerCount).toBe(1);
  });

  it('renders categories in fixed CATEGORY_ORDER', () => {
    const block = renderPlaybookBlock(makeAccount({ settings: {}, pricingTableRows: 3 }));
    let lastIdx = -1;
    for (const cat of CATEGORY_ORDER) {
      const idx = block.indexOf(`[${CATEGORY_DISPLAY_LABELS[cat]}]`);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });
});

describe('previewPlaybookCategories — UI helper', () => {
  it('returns one entry per category in fixed order', () => {
    const preview = previewPlaybookCategories(makeAccount({ settings: {}, pricingTableRows: 3 }));
    expect(preview.map(p => p.category)).toEqual(Array.from(CATEGORY_ORDER));
  });

  it('surfaces both the behavior bullets and the user instructions per category', () => {
    const instructions: PlaybookInstructionsBlob = {
      pricing: 'Custom pricing rules here',
      opt_out: '',
    };
    const preview = previewPlaybookCategories(makeAccount({
      settings: { aiPlaybookInstructions: instructions }, pricingTableRows: 5,
    }));
    const pricing = preview.find(p => p.category === 'pricing')!;
    expect(pricing.instructions).toBe('Custom pricing rules here');
    expect(pricing.behaviorBullets.length).toBeGreaterThan(0);

    const optOut = preview.find(p => p.category === 'opt_out')!;
    expect(optOut.instructions).toBe('');
    expect(optOut.behaviorBullets).toContain('Do not contact again.');
  });
});
