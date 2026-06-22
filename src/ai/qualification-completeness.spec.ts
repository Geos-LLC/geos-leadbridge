import {
  parseRequiredFields,
  detectFieldsInText,
  detectFieldsInClassifierFacts,
  collectedFields,
  missingRequiredFields,
} from './qualification-completeness';

describe('parseRequiredFields', () => {
  it('returns [] for null/empty/malformed JSON', () => {
    expect(parseRequiredFields(null)).toEqual([]);
    expect(parseRequiredFields(undefined as any)).toEqual([]);
    expect(parseRequiredFields('')).toEqual([]);
    expect(parseRequiredFields('{not json')).toEqual([]);
  });

  it('returns [] when qualificationV2.requiredFields is missing', () => {
    expect(parseRequiredFields('{}')).toEqual([]);
    expect(parseRequiredFields('{"qualificationV2":{}}')).toEqual([]);
  });

  it('keeps only canonical field keys', () => {
    const json = JSON.stringify({
      qualificationV2: {
        requiredFields: ['bedrooms', 'flux_capacitor', 'square_footage', 'phone_number'],
      },
    });
    expect(parseRequiredFields(json)).toEqual(['bedrooms', 'square_footage', 'phone_number']);
  });

  it('dedupes', () => {
    const json = JSON.stringify({
      qualificationV2: { requiredFields: ['bedrooms', 'bedrooms', 'bathrooms'] },
    });
    expect(parseRequiredFields(json)).toEqual(['bedrooms', 'bathrooms']);
  });
});

describe('detectFieldsInText', () => {
  it('detects bedrooms in various forms', () => {
    expect(detectFieldsInText('3 bedrooms')).toContain('bedrooms');
    expect(detectFieldsInText('3-bedroom home')).toContain('bedrooms');
    expect(detectFieldsInText('two bedrooms')).toContain('bedrooms');
    expect(detectFieldsInText('3br')).toContain('bedrooms');
  });

  it('detects bathrooms', () => {
    expect(detectFieldsInText('2 bathrooms')).toContain('bathrooms');
    expect(detectFieldsInText('1.5 bath')).toContain('bathrooms');
  });

  it('detects square footage', () => {
    expect(detectFieldsInText('about 2100 sqft')).toContain('square_footage');
    expect(detectFieldsInText('roughly 1,800 sq ft')).toContain('square_footage');
    expect(detectFieldsInText('950 square feet')).toContain('square_footage');
  });

  it('detects phone numbers but not raw 5-digit ZIPs', () => {
    expect(detectFieldsInText('call me at 248-555-1234')).toContain('phone_number');
    expect(detectFieldsInText('(813) 921-2100')).toContain('phone_number');
    expect(detectFieldsInText('+1 904-555-1212')).toContain('phone_number');
    expect(detectFieldsInText('32222 zip code is correct')).not.toContain('phone_number');
  });

  it('detects frequency', () => {
    expect(detectFieldsInText('weekly')).toContain('frequency');
    expect(detectFieldsInText('Every 2 weeks')).toContain('frequency');
    expect(detectFieldsInText('biweekly please')).toContain('frequency');
    expect(detectFieldsInText('one-time only')).toContain('frequency');
  });

  it('detects ZIP code', () => {
    expect(detectFieldsInText('32222')).toContain('zip_code');
    expect(detectFieldsInText('32222 zip code is correct')).toContain('zip_code');
  });

  it('detects service_date for explicit dates / weekdays but not "flexible"', () => {
    expect(detectFieldsInText('Friday works')).toContain('service_date');
    expect(detectFieldsInText('tomorrow at 2pm')).toContain('service_date');
    expect(detectFieldsInText("I'm flexible")).not.toContain('service_date');
    expect(detectFieldsInText('any day is fine')).not.toContain('service_date');
  });

  it('detects condition keywords', () => {
    expect(detectFieldsInText('move-out cleaning')).toContain('condition');
    expect(detectFieldsInText('deep clean please')).toContain('condition');
  });

  it('detects scope_extras', () => {
    expect(detectFieldsInText('refrigerator cleaning')).toContain('scope_extras');
    expect(detectFieldsInText('I have pets')).toContain('scope_extras');
    expect(detectFieldsInText('inside windows')).toContain('scope_extras');
  });

  it('returns empty set on empty / null input', () => {
    expect(detectFieldsInText('')).toEqual(new Set());
    expect(detectFieldsInText(null as any)).toEqual(new Set());
  });
});

describe('detectFieldsInClassifierFacts', () => {
  it('returns empty when no facts', () => {
    expect(detectFieldsInClassifierFacts(undefined)).toEqual(new Set());
  });

  it('reads each field defensively', () => {
    expect(detectFieldsInClassifierFacts({
      phoneNumber: '2485551234',
      squareFootage: 1800,
      bedrooms: 3,
      bathrooms: 2,
      preferredDateTime: 'Friday',
    })).toEqual(new Set(['phone_number', 'square_footage', 'bedrooms', 'bathrooms', 'service_date']));
  });

  it('rejects garbage values', () => {
    expect(detectFieldsInClassifierFacts({
      phoneNumber: '123', // too short
      squareFootage: 50,  // too small
      bedrooms: 0,
      bathrooms: 0,
      preferredDateTime: '',
    } as any)).toEqual(new Set());
  });
});

describe('collectedFields + missingRequiredFields — Lawrence Parker scenario', () => {
  // Recreates the Spotless JAX 2026-06-20 case: Yelp prefilled form had
  // bedrooms + frequency + scope_extras + cleaning category, then the
  // customer's only follow-up answer was a ZIP confirmation. sqft,
  // bathrooms, phone were never mentioned.
  const customerMessages = [
    'Hi there, please respond with a price estimate. Here are my answers to Yelp\'s questions regarding my project: What kind of cleaning service are you looking for? Regular cleaning How often do you want your home cleaned? Every 2 weeks Do you need any of these other services? Refrigerator cleaning How many bedrooms are in your home? 3 bedrooms When do you require this service? I\'m flexible',
    '32222 zip code is correct',
  ];

  it('detects bedrooms + frequency + scope_extras + zip but NOT sqft/bathrooms/phone', () => {
    const collected = collectedFields({ customerMessages });
    expect(collected.has('bedrooms')).toBe(true);
    expect(collected.has('frequency')).toBe(true);
    expect(collected.has('scope_extras')).toBe(true);
    expect(collected.has('zip_code')).toBe(true);
    expect(collected.has('square_footage')).toBe(false);
    expect(collected.has('bathrooms')).toBe(false);
    expect(collected.has('phone_number')).toBe(false);
  });

  it('flags sqft + bathrooms + phone as missing for the Spotless JAX required set', () => {
    const required = ['bedrooms', 'bathrooms', 'square_footage', 'frequency', 'phone_number'];
    const collected = collectedFields({ customerMessages });
    expect(missingRequiredFields(required, collected)).toEqual([
      'bathrooms', 'square_footage', 'phone_number',
    ]);
  });

  it('honors lead.customerPhone fallback', () => {
    const required = ['phone_number'];
    const collected = collectedFields({
      customerMessages: ['hi'],
      leadCustomerPhone: '+19045551212',
    });
    expect(collected.has('phone_number')).toBe(true);
    expect(missingRequiredFields(required, collected)).toEqual([]);
  });

  it('returns nothing missing once the customer fills the gaps', () => {
    const required = ['bedrooms', 'bathrooms', 'square_footage', 'frequency', 'phone_number'];
    const collected = collectedFields({
      customerMessages: [
        ...customerMessages,
        '2 bathrooms and the house is about 1800 sq ft. You can reach me at 904-555-7777.',
      ],
    });
    expect(missingRequiredFields(required, collected)).toEqual([]);
  });
});
