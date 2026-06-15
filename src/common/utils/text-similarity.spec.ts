import { jaccardSimilarity } from './text-similarity';

describe('jaccardSimilarity', () => {
  it('identical strings → 1', () => {
    expect(jaccardSimilarity('weekly cleaning service', 'weekly cleaning service')).toBe(1);
  });

  it('disjoint strings → 0', () => {
    expect(jaccardSimilarity('weekly cleaning', 'lawn mowing')).toBeLessThan(0.2);
  });

  it('null/empty → 0 (never false-positives as 1)', () => {
    expect(jaccardSimilarity(null, null)).toBe(0);
    expect(jaccardSimilarity('', '')).toBe(0);
    expect(jaccardSimilarity('hello', null)).toBe(0);
    expect(jaccardSimilarity(null, 'hello')).toBe(0);
  });

  it('stopwords ignored', () => {
    // "a the and" are all stopwords; only "house cleaning" tokens count
    const a = 'a house cleaning the and';
    const b = 'house cleaning';
    expect(jaccardSimilarity(a, b)).toBe(1);
  });

  it('punctuation stripped, case-insensitive', () => {
    expect(jaccardSimilarity('Deep-clean, MOVE-OUT!', 'deep clean move out')).toBe(1);
  });

  it('partial overlap returns proportional similarity', () => {
    const a = 'weekly house cleaning standard';
    const b = 'weekly house cleaning deep';
    // 3 shared tokens / 5 union = 0.6
    expect(jaccardSimilarity(a, b)).toBeGreaterThan(0.5);
    expect(jaccardSimilarity(a, b)).toBeLessThan(0.8);
  });

  it('threshold compatibility: real-world TT-style messages', () => {
    const msg1 = 'Hi, I need weekly house cleaning for my 3-bedroom home in Brooklyn.';
    const msg2 = 'Looking for weekly cleaning for my 3 bedroom house in Brooklyn';
    expect(jaccardSimilarity(msg1, msg2)).toBeGreaterThanOrEqual(0.5);
  });
});
