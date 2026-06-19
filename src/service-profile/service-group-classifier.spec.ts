import {
  classifyLeadCategory,
  deriveServiceGroupFromMappings,
  SERVICE_GROUP_PRIORITY,
} from './service-group-classifier';

describe('classifyLeadCategory', () => {
  it('returns [other] for empty / null / whitespace input', () => {
    expect(classifyLeadCategory('')).toEqual(['other']);
    expect(classifyLeadCategory(null)).toEqual(['other']);
    expect(classifyLeadCategory(undefined)).toEqual(['other']);
    expect(classifyLeadCategory('   ')).toEqual(['other']);
  });

  it('classifies house-cleaning variants Yelp actually sends', () => {
    expect(classifyLeadCategory('House Cleaning')).toEqual(['cleaning']);
    expect(classifyLeadCategory('Home Cleaning')).toEqual(['cleaning']);
    expect(classifyLeadCategory('Regular home cleaning')).toEqual(['cleaning']);
    expect(classifyLeadCategory('Deep cleaning')).toEqual(['cleaning']);
    expect(classifyLeadCategory('Move-in or move-out cleaning')).toEqual(['cleaning']);
    expect(classifyLeadCategory('Maid services')).toEqual(['cleaning']);
    expect(classifyLeadCategory('Janitorial services')).toEqual(['cleaning']);
    expect(classifyLeadCategory('Housekeeping')).toEqual(['cleaning']);
    expect(classifyLeadCategory('Post-construction cleaning')).toEqual(['cleaning']);
    expect(classifyLeadCategory('Commercial standard cleaning')).toEqual(['cleaning']);
  });

  it('classifies upholstery / carpet variants', () => {
    expect(classifyLeadCategory('Upholstery and Furniture Cleaning')).toEqual(['upholstery_carpet', 'cleaning']);
    expect(classifyLeadCategory('Carpet Cleaning')).toEqual(['upholstery_carpet', 'cleaning']);
    expect(classifyLeadCategory('Rug cleaning')).toEqual(['upholstery_carpet', 'cleaning']);
    expect(classifyLeadCategory('Sofa cleaning')).toEqual(['upholstery_carpet', 'cleaning']);
    expect(classifyLeadCategory('Drapery cleaning')).toEqual(['upholstery_carpet', 'cleaning']);
  });

  it('returns multiple groups in PRIORITY order for combined categories', () => {
    // Yelp's "Carpet and upholstery cleaning" matches both groups —
    // resolver picks upholstery_carpet first if the tenant has it.
    const groups = classifyLeadCategory('Carpet and upholstery cleaning');
    expect(groups).toEqual(['upholstery_carpet', 'cleaning']);
    // First-match-wins in the resolver: upholstery_carpet appears first
    // because PRIORITY puts it before cleaning.
    expect(groups[0]).toBe('upholstery_carpet');
  });

  it('returns [other] for strings that hit no niche regex', () => {
    expect(classifyLeadCategory('Plumbing')).toEqual(['other']);
    expect(classifyLeadCategory('Lawn Care')).toEqual(['other']);
    expect(classifyLeadCategory('Roofing repair')).toEqual(['other']);
    expect(classifyLeadCategory('HVAC installation')).toEqual(['other']);
  });

  it('does not false-positive on substring traps', () => {
    // "rugged" contains "rug" but not as a whole word — must NOT match
    expect(classifyLeadCategory('rugged terrain')).toEqual(['other']);
    // "carbon" / "carpentry" should not trip "carpet"
    expect(classifyLeadCategory('Carbon monoxide testing')).toEqual(['other']);
    expect(classifyLeadCategory('Carpentry repair')).toEqual(['other']);
    // "cleansing" should not trip "cleaning" (different word)
    expect(classifyLeadCategory('Drain cleansing')).toEqual(['other']);
  });

  it('case-insensitive', () => {
    expect(classifyLeadCategory('CLEANING')).toEqual(['cleaning']);
    expect(classifyLeadCategory('carpet')).toEqual(['upholstery_carpet']);
    expect(classifyLeadCategory('Sofa Cleaning')).toEqual(['upholstery_carpet', 'cleaning']);
  });
});

describe('deriveServiceGroupFromMappings', () => {
  it('returns upholstery_carpet when any mapping is upholstery/carpet', () => {
    expect(deriveServiceGroupFromMappings([
      { provider: 'thumbtack', categoryName: 'House Cleaning' },
      { provider: 'thumbtack', categoryName: 'Upholstery and Furniture Cleaning' },
    ])).toBe('upholstery_carpet');
  });

  it('returns cleaning when only cleaning mappings present', () => {
    expect(deriveServiceGroupFromMappings([
      { provider: 'thumbtack', categoryName: 'House Cleaning' },
      { provider: 'yelp', categoryName: 'Deep cleaning' },
    ])).toBe('cleaning');
  });

  it('returns other for empty array', () => {
    expect(deriveServiceGroupFromMappings([])).toBe('other');
  });

  it('returns other when no mapping matches any group regex', () => {
    expect(deriveServiceGroupFromMappings([
      { provider: 'thumbtack', categoryName: 'Plumbing' },
      { provider: 'thumbtack', categoryName: 'Roofing' },
    ])).toBe('other');
  });

  it('tolerates undefined / missing categoryName', () => {
    expect(deriveServiceGroupFromMappings([
      { provider: 'thumbtack' },
      { provider: 'yelp', categoryName: null as any },
      { provider: 'thumbtack', categoryName: 'House Cleaning' },
    ])).toBe('cleaning');
  });
});

describe('SERVICE_GROUP_PRIORITY', () => {
  it('puts more-specific groups first', () => {
    // upholstery_carpet > cleaning > other — a tenant with both
    // profiles routes carpet leads to the carpet profile, not the
    // cleaning profile.
    expect(SERVICE_GROUP_PRIORITY).toEqual(['upholstery_carpet', 'cleaning', 'other']);
  });
});
