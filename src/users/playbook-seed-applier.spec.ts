import { seedToSectionLines, seedToCustomInstructions, SUPPORTED_SECTIONS } from './playbook-seed-applier';
import type { PlaybookSeed } from './users.service';

describe('seedToSectionLines', () => {
  it('returns empty arrays when seed is empty', () => {
    const out = seedToSectionLines({});
    expect(out.business_information).toEqual([]);
    expect(out.pricing_guidance).toEqual([]);
    expect(out.personality_brand_voice).toEqual([]);
  });

  describe('business_information', () => {
    it('emits core business fields as factual lines', () => {
      const seed: PlaybookSeed = {
        businessInformation: {
          serviceArea: 'Tampa, St. Petersburg',
          yearsInBusiness: '5 years',
          insurance: 'Fully insured',
          bonding: 'Bonded',
        },
      };
      const out = seedToSectionLines(seed);
      expect(out.business_information).toContain('Service area: Tampa, St. Petersburg.');
      expect(out.business_information).toContain('Years in business: 5 years.');
      expect(out.business_information).toContain('Insurance: Fully insured.');
      expect(out.business_information).toContain('Bonding: Bonded.');
    });

    it('absorbs contact facts from humanHandoffGuidance', () => {
      const seed: PlaybookSeed = {
        humanHandoffGuidance: {
          phones: ['813-921-2100'],
          emails: ['info@spotless.homes'],
          addresses: ['Tampa office'],
        },
      };
      const out = seedToSectionLines(seed);
      expect(out.business_information).toContain('Phone: 813-921-2100.');
      expect(out.business_information).toContain('Email: info@spotless.homes.');
      expect(out.business_information).toContain('Address: Tampa office.');
      // None should leak into pricing or comms style
      expect(out.pricing_guidance).toEqual([]);
      expect(out.personality_brand_voice).toEqual([]);
    });

    it('absorbs booking facts from bookingGuidance', () => {
      const seed: PlaybookSeed = {
        bookingGuidance: {
          bookingChannels: ['Online form', 'Phone'],
          leadTime: '48 hours',
          schedulingNotes: 'Customers can request service online or by phone.',
        },
      };
      const out = seedToSectionLines(seed);
      expect(out.business_information).toContain('Booking channels: Online form, Phone.');
      expect(out.business_information).toContain('Lead time: 48 hours.');
      expect(out.business_information).toContain('Scheduling notes: Customers can request service online or by phone.');
    });

    it('emits payment methods + office locations from arrays', () => {
      const seed: PlaybookSeed = {
        businessInformation: {
          paymentMethods: ['Card', 'Cash', 'Venmo'],
          officeLocations: ['Tampa office', 'Jacksonville office'],
        },
      };
      const out = seedToSectionLines(seed);
      expect(out.business_information).toContain('Payment methods: Card, Cash, Venmo.');
      expect(out.business_information).toContain('Office locations: Tampa office; Jacksonville office.');
    });
  });

  describe('pricing_guidance', () => {
    it('emits pricing fields as factual lines', () => {
      const seed: PlaybookSeed = {
        pricingGuidance: {
          pricingModel: 'Pricing depends on home size, service type, and condition',
          startingPrices: [
            { service: 'Standard cleaning', price: 'from $129' },
            { service: 'Deep cleaning',     price: 'from $179' },
          ],
          discounts: 'Recurring service discounts are available',
        },
      };
      const out = seedToSectionLines(seed);
      expect(out.pricing_guidance).toContain(
        'Pricing model: Pricing depends on home size, service type, and condition.',
      );
      expect(out.pricing_guidance).toContain(
        'Starting prices: Standard cleaning from $129; Deep cleaning from $179.',
      );
      expect(out.pricing_guidance).toContain('Discounts: Recurring service discounts are available.');
    });

    it('catches price-related trust signals (price word)', () => {
      const seed: PlaybookSeed = {
        objectionHandling: {
          trustSignals: ['Best prices in town', 'Bonded since 2015'],
        },
      };
      const out = seedToSectionLines(seed);
      const pricingLine = out.pricing_guidance.find(l => l.includes('Best prices'));
      const commsLine = out.personality_brand_voice.find(l => l.includes('Bonded since 2015'));
      expect(pricingLine).toBeTruthy();
      expect(commsLine).toBeTruthy();
    });

    it('catches price-related trust signals (guarantee word)', () => {
      const seed: PlaybookSeed = {
        objectionHandling: {
          trustSignals: ['Satisfaction guarantee'],
        },
      };
      const out = seedToSectionLines(seed);
      expect(out.pricing_guidance.some(l => l.includes('Satisfaction guarantee'))).toBe(true);
      expect(out.personality_brand_voice.some(l => l.includes('Satisfaction guarantee'))).toBe(false);
    });
  });

  describe('personality_brand_voice (Communication Style & Brand Voice)', () => {
    it('emits toneNotes verbatim', () => {
      const seed: PlaybookSeed = {
        personalityBrandVoice: {
          toneNotes: 'Friendly, professional, local. Match customer energy.',
        },
      };
      const out = seedToSectionLines(seed);
      expect(out.personality_brand_voice).toContain('Friendly, professional, local. Match customer energy.');
    });

    it('catches generic (non-price) trust signals', () => {
      const seed: PlaybookSeed = {
        objectionHandling: {
          trustSignals: ['Fully insured', 'Same-day service available', 'Local family business'],
        },
      };
      const out = seedToSectionLines(seed);
      // 'Fully insured' has no price keyword → comms style
      const commsLine = out.personality_brand_voice.find(l => l.includes('Fully insured'));
      expect(commsLine).toBeTruthy();
      expect(commsLine).toContain('Same-day service available');
      expect(commsLine).toContain('Local family business');
    });

    it('routes mixed trust signals to correct sections', () => {
      const seed: PlaybookSeed = {
        objectionHandling: {
          trustSignals: [
            'Best prices in Tampa',         // price → pricing
            'Family-owned since 2010',       // generic → comms
            'Satisfaction guarantee',        // guarantee → pricing
            'Same-day service available',    // generic → comms
          ],
        },
      };
      const out = seedToSectionLines(seed);
      // Pricing line contains price-related ones
      const pricingLine = out.pricing_guidance.find(l => l.startsWith('Value / trust signals:'));
      expect(pricingLine).toContain('Best prices in Tampa');
      expect(pricingLine).toContain('Satisfaction guarantee');
      expect(pricingLine).not.toContain('Family-owned');
      expect(pricingLine).not.toContain('Same-day');
      // Comms line contains the generic ones
      const commsLine = out.personality_brand_voice.find(l => l.startsWith('Trust signals to surface'));
      expect(commsLine).toContain('Family-owned since 2010');
      expect(commsLine).toContain('Same-day service available');
      expect(commsLine).not.toContain('Best prices');
      expect(commsLine).not.toContain('Satisfaction guarantee');
    });

    it('does not emit a trust-signal line when there are no signals', () => {
      const seed: PlaybookSeed = {
        objectionHandling: { trustSignals: [] },
      };
      const out = seedToSectionLines(seed);
      expect(out.personality_brand_voice).toEqual([]);
      expect(out.pricing_guidance).toEqual([]);
    });

    it('ignores non-string trust signal entries', () => {
      const seed: any = {
        objectionHandling: { trustSignals: ['Real signal', null, 42, '', '   '] },
      };
      const out = seedToSectionLines(seed);
      // Only "Real signal" survives
      const commsLine = out.personality_brand_voice.find(l => l.includes('Real signal'));
      expect(commsLine).toBeTruthy();
    });
  });

  it('exposes exactly 3 supported sections', () => {
    expect(SUPPORTED_SECTIONS).toEqual([
      'business_information',
      'pricing_guidance',
      'personality_brand_voice',
    ]);
  });

  it('NEVER writes to hidden sections', () => {
    const seed: PlaybookSeed = {
      businessInformation: { serviceArea: 'Tampa' },
      pricingGuidance:     { pricingModel: 'Hourly' },
      bookingGuidance:     { bookingChannels: ['Online'] },
      objectionHandling:   { trustSignals: ['Fully insured'] },
      humanHandoffGuidance: { phones: ['555-1212'] },
      personalityBrandVoice: { toneNotes: 'Friendly' },
    };
    const out = seedToSectionLines(seed) as any;
    // Verify the result only has the 3 supported keys
    expect(Object.keys(out).sort()).toEqual([
      'business_information',
      'personality_brand_voice',
      'pricing_guidance',
    ]);
    // No 'booking_guidance', 'objection_handling', 'human_handoff_guidance',
    // 'qualification_guidance', 'followup_tone', 'phone_call_guidance' keys
    expect(out.booking_guidance).toBeUndefined();
    expect(out.objection_handling).toBeUndefined();
    expect(out.human_handoff_guidance).toBeUndefined();
  });
});

describe('seedToCustomInstructions (legacy adapter)', () => {
  it('returns Partial Record shape with joined lines', () => {
    const seed: PlaybookSeed = {
      businessInformation: { serviceArea: 'Tampa', insurance: 'Fully insured' },
      pricingGuidance:     { pricingModel: 'Hourly' },
    };
    const out = seedToCustomInstructions(seed);
    expect(out.business_information).toContain('Service area: Tampa.');
    expect(out.business_information).toContain('Insurance: Fully insured.');
    expect(out.business_information!.split('\n').length).toBe(2);
    expect(out.pricing_guidance).toBe('Pricing model: Hourly.');
    expect(out.personality_brand_voice).toBeUndefined();
  });

  it('omits keys for sections with no content', () => {
    const out = seedToCustomInstructions({});
    expect(out.business_information).toBeUndefined();
    expect(out.pricing_guidance).toBeUndefined();
    expect(out.personality_brand_voice).toBeUndefined();
  });
});
