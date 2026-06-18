import {
  buildAvailabilityBlock,
  buildAvailabilityBlockForStrategy,
  normalizeBookingAvailability,
  DEFAULT_BOOKING_AVAILABILITY,
  BOOKING_DAY_KEYS,
} from './booking-availability';

describe('DEFAULT_BOOKING_AVAILABILITY', () => {
  it('opens Mon–Fri morning + afternoon, closes weekends', () => {
    for (const d of ['mon', 'tue', 'wed', 'thu', 'fri'] as const) {
      expect(DEFAULT_BOOKING_AVAILABILITY[d].morning).toBe(true);
      expect(DEFAULT_BOOKING_AVAILABILITY[d].afternoon).toBe(true);
    }
    for (const d of ['sat', 'sun'] as const) {
      expect(DEFAULT_BOOKING_AVAILABILITY[d].morning).toBe(false);
      expect(DEFAULT_BOOKING_AVAILABILITY[d].afternoon).toBe(false);
    }
  });

  it('BOOKING_DAY_KEYS lists Mon → Sun in calendar order', () => {
    expect([...BOOKING_DAY_KEYS]).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  });
});

describe('normalizeBookingAvailability', () => {
  it('returns the default when input is undefined / null / non-object', () => {
    expect(normalizeBookingAvailability(undefined)).toEqual(DEFAULT_BOOKING_AVAILABILITY);
    expect(normalizeBookingAvailability(null)).toEqual(DEFAULT_BOOKING_AVAILABILITY);
    expect(normalizeBookingAvailability('not an object')).toEqual(DEFAULT_BOOKING_AVAILABILITY);
    expect(normalizeBookingAvailability(42)).toEqual(DEFAULT_BOOKING_AVAILABILITY);
  });

  it('fills missing days from the default', () => {
    const partial = { mon: { morning: false, afternoon: false } };
    const out = normalizeBookingAvailability(partial);
    expect(out.mon).toEqual({ morning: false, afternoon: false });
    expect(out.tue).toEqual(DEFAULT_BOOKING_AVAILABILITY.tue);
    expect(out.sat).toEqual(DEFAULT_BOOKING_AVAILABILITY.sat);
  });

  it('coerces non-boolean period values back to defaults for that day', () => {
    const garbage = {
      mon: { morning: 'yes', afternoon: 1 },
      tue: { morning: null, afternoon: undefined },
    };
    const out = normalizeBookingAvailability(garbage);
    // Mon defaults are both true, both period values were garbage → both true.
    expect(out.mon).toEqual({ morning: true, afternoon: true });
    // Tue defaults are both true; null / undefined → fall back to defaults.
    expect(out.tue).toEqual({ morning: true, afternoon: true });
  });

  it('drops unknown day keys silently', () => {
    const out = normalizeBookingAvailability({
      mon: { morning: true, afternoon: true },
      flux: { morning: true, afternoon: true },
    } as any);
    expect((out as any).flux).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual(['fri', 'mon', 'sat', 'sun', 'thu', 'tue', 'wed']);
  });

  it('preserves an all-off saved state', () => {
    const allOff = {
      mon: { morning: false, afternoon: false },
      tue: { morning: false, afternoon: false },
      wed: { morning: false, afternoon: false },
      thu: { morning: false, afternoon: false },
      fri: { morning: false, afternoon: false },
      sat: { morning: false, afternoon: false },
      sun: { morning: false, afternoon: false },
    };
    expect(normalizeBookingAvailability(allOff)).toEqual(allOff);
  });
});

describe('buildAvailabilityBlock', () => {
  it('emits the default Mon–Fri morning + afternoon windows for fresh accounts', () => {
    const out = buildAvailabilityBlock(undefined);
    expect(out).toContain('Monday morning');
    expect(out).toContain('Monday afternoon');
    expect(out).toContain('Friday morning');
    expect(out).toContain('Friday afternoon');
    expect(out).not.toContain('Saturday');
    expect(out).not.toContain('Sunday');
  });

  it('emits day labels in Mon → Sun order', () => {
    const out = buildAvailabilityBlock({
      mon: { morning: true,  afternoon: false },
      tue: { morning: false, afternoon: true  },
      wed: { morning: false, afternoon: false },
      thu: { morning: false, afternoon: false },
      fri: { morning: false, afternoon: false },
      sat: { morning: true,  afternoon: false },
      sun: { morning: false, afternoon: false },
    });
    const monIdx = out.indexOf('Monday morning');
    const tueIdx = out.indexOf('Tuesday afternoon');
    const satIdx = out.indexOf('Saturday morning');
    expect(monIdx).toBeGreaterThan(-1);
    expect(tueIdx).toBeGreaterThan(monIdx);
    expect(satIdx).toBeGreaterThan(tueIdx);
  });

  it('emits empty string when EVERY slot is off (so we never tell the AI "no slots")', () => {
    const out = buildAvailabilityBlock({
      mon: { morning: false, afternoon: false },
      tue: { morning: false, afternoon: false },
      wed: { morning: false, afternoon: false },
      thu: { morning: false, afternoon: false },
      fri: { morning: false, afternoon: false },
      sat: { morning: false, afternoon: false },
      sun: { morning: false, afternoon: false },
    });
    expect(out).toBe('');
  });

  it('instructs the AI to offer EXACTLY TWO windows', () => {
    const out = buildAvailabilityBlock(undefined);
    expect(out).toMatch(/EXACTLY TWO/);
  });

  it('forbids inventing windows that are not listed', () => {
    const out = buildAvailabilityBlock(undefined);
    expect(out).toMatch(/Do not invent/i);
  });

  it('drops a single period when only one side of the day is on', () => {
    const onlyMornings = {
      mon: { morning: true, afternoon: false },
      tue: { morning: true, afternoon: false },
      wed: { morning: true, afternoon: false },
      thu: { morning: true, afternoon: false },
      fri: { morning: true, afternoon: false },
      sat: { morning: false, afternoon: false },
      sun: { morning: false, afternoon: false },
    };
    const out = buildAvailabilityBlock(onlyMornings);
    // Exactly five "- <Day> morning" bullets, zero afternoon bullets.
    // We match the bullet shape directly so the AI-facing example
    // sentence further down ("Tuesday morning or Thursday afternoon")
    // doesn't poison the count.
    const morningBullets = (out.match(/^- \w+ morning$/gm) || []).length;
    const afternoonBullets = (out.match(/^- \w+ afternoon$/gm) || []).length;
    expect(morningBullets).toBe(5);
    expect(afternoonBullets).toBe(0);
  });
});

describe('buildAvailabilityBlockForStrategy', () => {
  it('emits the block only for the booking strategy', () => {
    const out = buildAvailabilityBlockForStrategy('booking', undefined);
    expect(out).toContain('Monday morning');
  });

  it('returns empty string for every non-booking strategy', () => {
    for (const s of ['auto', 'price', 'qualify', 'phone', 'hybrid', 'convert']) {
      expect(buildAvailabilityBlockForStrategy(s, undefined)).toBe('');
    }
  });

  it('returns empty string when strategy is undefined / null', () => {
    expect(buildAvailabilityBlockForStrategy(undefined, undefined)).toBe('');
    expect(buildAvailabilityBlockForStrategy(null, undefined)).toBe('');
  });

  it('survives malformed saved data without crashing', () => {
    expect(() => buildAvailabilityBlockForStrategy('booking', 'garbage')).not.toThrow();
    expect(() => buildAvailabilityBlockForStrategy('booking', 42)).not.toThrow();
    expect(() => buildAvailabilityBlockForStrategy('booking', [])).not.toThrow();
  });
});
