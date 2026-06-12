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

describe('buildQualificationBlockForStrategy', () => {
  it('emits block when strategy is price', () => {
    const out = buildQualificationBlockForStrategy('price', ['square_footage']);
    expect(out).toContain('Square Footage');
  });

  it('emits block when strategy is qualify', () => {
    const out = buildQualificationBlockForStrategy('qualify', ['phone_number']);
    expect(out).toContain('Phone Number');
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

  it('returns empty string for phone strategy', () => {
    expect(buildQualificationBlockForStrategy('phone', ['square_footage'])).toBe('');
  });

  it('returns empty string when strategy is undefined', () => {
    expect(buildQualificationBlockForStrategy(undefined, ['square_footage'])).toBe('');
  });

  it('returns empty string when required fields is missing even for price/qualify', () => {
    expect(buildQualificationBlockForStrategy('price', undefined)).toBe('');
    expect(buildQualificationBlockForStrategy('qualify', null)).toBe('');
  });
});
