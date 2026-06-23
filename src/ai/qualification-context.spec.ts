import {
  buildQualificationBlock,
  buildQualificationBlockForStrategy,
  parseProfileQualificationExtras,
} from './qualification-context';

describe('buildQualificationBlock', () => {
  it('returns empty string when input is undefined', () => {
    expect(buildQualificationBlock(undefined)).toBe('');
  });

  it('returns empty string when input is not an array', () => {
    expect(buildQualificationBlock('square_footage')).toBe('');
    expect(buildQualificationBlock({ requiredFields: ['square_footage'] })).toBe('');
    expect(buildQualificationBlock(null)).toBe('');
  });

  it('returns empty string when array is empty', () => {
    expect(buildQualificationBlock([])).toBe('');
  });

  it('returns empty string when array contains only unknown keys', () => {
    expect(buildQualificationBlock(['flux_capacitor', 'warp_drive'])).toBe('');
  });

  it('drops unknown keys but keeps known ones', () => {
    const out = buildQualificationBlock(['square_footage', 'flux_capacitor', 'phone_number']);
    expect(out).toContain('Square Footage');
    expect(out).toContain('Phone Number');
    expect(out).not.toContain('flux_capacitor');
  });

  it('emits keys in canonical catalog order regardless of input order', () => {
    // Catalog order is: square_footage, service_date, phone_number, ...
    const out = buildQualificationBlock(['phone_number', 'square_footage', 'service_date']);
    const sfIdx = out.indexOf('Square Footage');
    const sdIdx = out.indexOf('Service Date');
    const pnIdx = out.indexOf('Phone Number');
    expect(sfIdx).toBeGreaterThan(-1);
    expect(sdIdx).toBeGreaterThan(sfIdx);
    expect(pnIdx).toBeGreaterThan(sdIdx);
  });

  it('dedupes repeated keys', () => {
    const out = buildQualificationBlock(['square_footage', 'square_footage', 'square_footage']);
    const matches = out.match(/Square Footage/g) || [];
    expect(matches.length).toBe(1);
  });

  it('survives non-string entries in the array', () => {
    const out = buildQualificationBlock([
      'square_footage',
      null,
      42,
      undefined,
      'phone_number',
    ]);
    expect(out).toContain('Square Footage');
    expect(out).toContain('Phone Number');
  });

  it('mentions transitioning forward after collection', () => {
    const out = buildQualificationBlock(['phone_number']);
    expect(out.toLowerCase()).toContain('transition forward');
  });

  it('all 10 catalog keys are recognized', () => {
    const all = [
      'square_footage', 'service_date', 'phone_number',
      'bedrooms', 'bathrooms', 'zip_code', 'address',
      'frequency', 'condition', 'scope_extras',
    ];
    const out = buildQualificationBlock(all);
    for (const key of all) {
      // Each emitted as a "- Label" bullet — at minimum confirm the bullet
      // count matches via counting newline-prefixed dashes after the intro line.
    }
    expect((out.match(/^- /gm) || []).length).toBe(10);
  });
});

describe('buildQualificationBlock — customFields', () => {
  it('returns empty when no built-ins and no custom fields', () => {
    expect(buildQualificationBlock([], [])).toBe('');
    expect(buildQualificationBlock(undefined, undefined)).toBe('');
  });

  it('emits a custom field row without question when question is empty', () => {
    const out = buildQualificationBlock([], [
      { id: 'cf-1', label: 'Pets', question: '', required: true },
    ]);
    expect(out).toContain('- Pets');
    expect(out).not.toContain('ask:');
  });

  it('emits a custom field row with quoted question when question is provided', () => {
    const out = buildQualificationBlock([], [
      { id: 'cf-1', label: 'Gate code', question: 'What is the gate code for entry?', required: true },
    ]);
    expect(out).toContain('- Gate code — ask: "What is the gate code for entry?"');
  });

  it('skips custom fields where required is false', () => {
    const out = buildQualificationBlock([], [
      { id: 'cf-1', label: 'Pets', question: '', required: true },
      { id: 'cf-2', label: 'Parking instructions', question: '', required: false },
    ]);
    expect(out).toContain('- Pets');
    expect(out).not.toContain('Parking instructions');
  });

  it('skips custom fields with blank labels', () => {
    const out = buildQualificationBlock([], [
      { id: 'cf-1', label: '', question: 'Something', required: true },
      { id: 'cf-2', label: '   ', question: '', required: true },
      { id: 'cf-3', label: 'Pets', question: '', required: true },
    ]);
    expect(out).toContain('- Pets');
    expect((out.match(/^- /gm) || []).length).toBe(1);
  });

  it('dedupes custom fields by label (case-insensitive) so a duplicate save does not double-emit', () => {
    const out = buildQualificationBlock([], [
      { id: 'cf-1', label: 'Pets', question: '', required: true },
      { id: 'cf-2', label: 'pets', question: 'Different question', required: true },
    ]);
    expect((out.match(/^- /gm) || []).length).toBe(1);
  });

  it('emits built-ins THEN custom fields in that order', () => {
    const out = buildQualificationBlock(['phone_number', 'square_footage'], [
      { id: 'cf-1', label: 'Pets', question: '', required: true },
    ]);
    const sfIdx = out.indexOf('Square Footage');
    const pnIdx = out.indexOf('Phone Number');
    const petsIdx = out.indexOf('- Pets');
    expect(sfIdx).toBeGreaterThan(-1);
    expect(pnIdx).toBeGreaterThan(sfIdx);
    expect(petsIdx).toBeGreaterThan(pnIdx);
  });

  it('handles malformed custom rows defensively', () => {
    const out = buildQualificationBlock([], [
      null,
      undefined,
      'string-not-object',
      { label: 'Pets', required: true }, // missing id + question
      { id: 'cf-2', label: 42, question: '', required: true }, // non-string label
    ] as any);
    expect(out).toContain('- Pets');
    expect((out.match(/^- /gm) || []).length).toBe(1);
  });

  it('mentions transitioning forward whether the block contains only customs', () => {
    const out = buildQualificationBlock([], [
      { id: 'cf-1', label: 'Pets', question: '', required: true },
    ]);
    expect(out.toLowerCase()).toContain('transition forward');
  });
});

describe('buildQualificationBlockForStrategy', () => {
  it('emits block when strategy is qualify', () => {
    const out = buildQualificationBlockForStrategy('qualify', ['phone_number']);
    expect(out).toContain('Phone Number');
  });

  // Booking (added 2026-06-16) also receives the REQUIRED FIELDS block —
  // the Booking prompt explicitly references it to decide whether to ask
  // one booking-critical question before asking for a date.
  it('emits block when strategy is booking', () => {
    const out = buildQualificationBlockForStrategy('booking', ['zip_code']);
    expect(out).toContain('Zip Code');
  });

  // Price was previously gated for injection alongside Qualify; tightened
  // to qualify-only when Price moved to Pricing-Table-driven behavior.
  // See qualification-context.ts header for the rationale.
  it('returns empty string for price strategy (handled by Pricing Table + Guidance)', () => {
    expect(buildQualificationBlockForStrategy('price', ['square_footage'])).toBe('');
  });

  it('returns empty string for auto strategy', () => {
    expect(buildQualificationBlockForStrategy('auto', ['square_footage'])).toBe('');
  });

  it('returns empty string for hybrid strategy', () => {
    expect(buildQualificationBlockForStrategy('hybrid', ['square_footage'])).toBe('');
  });

  it('returns empty string for convert strategy', () => {
    expect(buildQualificationBlockForStrategy('convert', ['square_footage'])).toBe('');
  });

  it('returns empty string for phone (Call Handoff) strategy', () => {
    expect(buildQualificationBlockForStrategy('phone', ['square_footage'])).toBe('');
  });

  it('returns empty string when strategy is undefined', () => {
    expect(buildQualificationBlockForStrategy(undefined, ['square_footage'])).toBe('');
  });

  it('returns empty string when required fields is missing even for qualify', () => {
    expect(buildQualificationBlockForStrategy('qualify', undefined)).toBe('');
    expect(buildQualificationBlockForStrategy('qualify', null)).toBe('');
  });

  it('returns empty string when required fields is missing even for booking', () => {
    expect(buildQualificationBlockForStrategy('booking', undefined)).toBe('');
    expect(buildQualificationBlockForStrategy('booking', null)).toBe('');
  });
});

describe('buildQualificationBlock — profileExtras', () => {
  it('emits service-specific fields from profile.serviceRules.requiredDetails when nothing else is set', () => {
    const out = buildQualificationBlock([], [], {
      requiredDetails: ['Number of seats', 'Fabric type', 'Mattress size'],
    });
    expect(out).toContain('- Number of seats');
    expect(out).toContain('- Fabric type');
    expect(out).toContain('- Mattress size');
    expect(out).not.toContain('Square Footage');
  });

  it('emits questions from profile.qualificationSchema.questions when nothing else is set', () => {
    const out = buildQualificationBlock([], [], {
      questions: [
        { key: 'furniture_pieces', label: 'Which furniture pieces do you need cleaned?', type: 'multi_select' },
        { key: 'fabric', label: 'What type of upholstery material is it?', type: 'single_select' },
      ],
    });
    expect(out).toContain('- Which furniture pieces do you need cleaned?');
    expect(out).toContain('- What type of upholstery material is it?');
  });

  it('emits profile-derived rows BEFORE the catalog built-ins so service-specific questions lead', () => {
    const out = buildQualificationBlock(['phone_number'], [], {
      requiredDetails: ['Number of seats'],
    });
    const seatsIdx = out.indexOf('- Number of seats');
    const phoneIdx = out.indexOf('Phone Number');
    expect(seatsIdx).toBeGreaterThan(-1);
    expect(phoneIdx).toBeGreaterThan(seatsIdx);
  });

  it('dedupes profile rows against the built-in catalog labels (case-insensitive)', () => {
    const out = buildQualificationBlock(['square_footage'], [], {
      requiredDetails: ['square footage', 'Square Footage', 'Number of seats'],
    });
    expect((out.match(/Square Footage/gi) || []).length).toBe(1);
    expect(out).toContain('- Number of seats');
  });

  it('dedupes profile rows against custom rows (case-insensitive)', () => {
    const out = buildQualificationBlock(
      [],
      [{ id: 'cf-1', label: 'Pets', question: '', required: true }],
      { requiredDetails: ['pets'] },
    );
    expect((out.match(/^- pets/gim) || []).length).toBe(1);
  });

  it('dedupes within profile rows when both sources name the same field', () => {
    const out = buildQualificationBlock([], [], {
      requiredDetails: ['Number of seats'],
      questions: [{ label: 'Number of seats' }, { label: 'Fabric type' }],
    });
    expect((out.match(/Number of seats/g) || []).length).toBe(1);
    expect(out).toContain('Fabric type');
  });

  it('survives malformed serviceRules.requiredDetails entries', () => {
    const out = buildQualificationBlock([], [], {
      requiredDetails: ['Sofa count', null, 42, undefined, '', '   ', 'Fabric type'],
    } as any);
    expect(out).toContain('Sofa count');
    expect(out).toContain('Fabric type');
    expect((out.match(/^- /gm) || []).length).toBe(2);
  });

  it('survives malformed qualificationSchema.questions entries', () => {
    const out = buildQualificationBlock([], [], {
      questions: [
        null,
        'string-not-object',
        { key: 'no_label' },
        { label: null },
        { label: 'Real question' },
      ],
    } as any);
    expect(out).toContain('Real question');
    expect((out.match(/^- /gm) || []).length).toBe(1);
  });

  it('returns empty string when builtins/custom/profile are all empty', () => {
    expect(buildQualificationBlock([], [], { requiredDetails: [], questions: [] })).toBe('');
    expect(buildQualificationBlock([], [], {})).toBe('');
  });

  it('preserves source order within profile rows (serviceRules first, then schema questions)', () => {
    const out = buildQualificationBlock([], [], {
      requiredDetails: ['Mattress size', 'Address'],
      questions: [{ label: 'Stain types' }],
    });
    const mattressIdx = out.indexOf('Mattress size');
    const addressIdx = out.indexOf('Address');
    const stainIdx = out.indexOf('Stain types');
    expect(mattressIdx).toBeGreaterThan(-1);
    expect(addressIdx).toBeGreaterThan(mattressIdx);
    expect(stainIdx).toBeGreaterThan(addressIdx);
  });
});

describe('buildQualificationBlockForStrategy — profileExtras', () => {
  it('passes profileExtras through to the underlying builder when strategy is qualify', () => {
    const out = buildQualificationBlockForStrategy(
      'qualify',
      undefined,
      undefined,
      { requiredDetails: ['Number of seats'] },
    );
    expect(out).toContain('Number of seats');
  });

  it('ignores profileExtras when strategy is not Qualify/Booking', () => {
    expect(
      buildQualificationBlockForStrategy(
        'price',
        undefined,
        undefined,
        { requiredDetails: ['Number of seats'] },
      ),
    ).toBe('');
    expect(
      buildQualificationBlockForStrategy(
        'convert',
        undefined,
        undefined,
        { requiredDetails: ['Number of seats'] },
      ),
    ).toBe('');
  });

  it('emits block even when only profileExtras has rows (account had nothing saved)', () => {
    // The Crystal Clear Care 2026-06-23 case: SavedAccount.followUpSettingsJson
    // is null, so the only source of REQUIRED FIELDS is the matched profile.
    const out = buildQualificationBlockForStrategy(
      'qualify',
      undefined,
      undefined,
      {
        requiredDetails: ['Number of seats', 'Fabric type'],
        questions: [{ label: 'Stain types' }],
      },
    );
    expect(out).toContain('Number of seats');
    expect(out).toContain('Fabric type');
    expect(out).toContain('Stain types');
    expect(out.toLowerCase()).toContain('transition forward');
  });
});

describe('parseProfileQualificationExtras', () => {
  it('returns empty extras when both inputs are null', () => {
    expect(parseProfileQualificationExtras(null, null)).toEqual({});
    expect(parseProfileQualificationExtras(undefined, undefined)).toEqual({});
  });

  it('pulls serviceRules.requiredDetails from a wrapper-shaped aiInstructionsJson', () => {
    const ai = JSON.stringify({
      version: 1,
      serviceRules: {
        requiredDetails: ['Number of seats', 'Fabric type'],
        unsupportedServices: ['Leather'],
      },
    });
    const out = parseProfileQualificationExtras(ai, null);
    expect(out.requiredDetails).toEqual(['Number of seats', 'Fabric type']);
    expect(out.questions).toBeUndefined();
  });

  it('pulls qualificationSchema.questions when present', () => {
    const schema = JSON.stringify({
      questions: [
        { key: 'a', label: 'Q1' },
        { key: 'b', label: 'Q2' },
      ],
    });
    const out = parseProfileQualificationExtras(null, schema);
    expect(Array.isArray(out.questions)).toBe(true);
    expect(out.requiredDetails).toBeUndefined();
  });

  it('returns both fields when both inputs are populated', () => {
    const ai = JSON.stringify({ serviceRules: { requiredDetails: ['Fabric'] } });
    const schema = JSON.stringify({ questions: [{ label: 'Seats?' }] });
    const out = parseProfileQualificationExtras(ai, schema);
    expect(out.requiredDetails).toEqual(['Fabric']);
    expect(Array.isArray(out.questions)).toBe(true);
  });

  it('returns empty extras silently when JSON is malformed', () => {
    expect(parseProfileQualificationExtras('{not json', '{nope')).toEqual({});
  });

  it('ignores non-array shapes', () => {
    const ai = JSON.stringify({ serviceRules: { requiredDetails: 'not an array' } });
    const schema = JSON.stringify({ questions: { notAnArray: true } });
    const out = parseProfileQualificationExtras(ai, schema);
    expect(out.requiredDetails).toBeUndefined();
    expect(out.questions).toBeUndefined();
  });
});
