import {
  buildQualificationBlock,
  buildQualificationBlockForStrategy,
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
