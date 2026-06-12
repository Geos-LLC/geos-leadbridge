import { seedToSectionLines, seedToCustomInstructions, SUPPORTED_SECTIONS } from './playbook-seed-applier';
import type { PlaybookSeed } from './users.service';

describe('seedToSectionLines (V2.5 mapping)', () => {
  it('returns empty arrays when seed is empty', () => {
    const out = seedToSectionLines({});
    expect(out.business_information).toEqual([]);
    expect(out.pricing_guidance).toEqual([]);
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
      expect(out.pricing_guidance).toEqual([]);
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

    it('absorbs ALL trust signals into business_information (no more split)', () => {
      const seed: PlaybookSeed = {
        objectionHandling: {
          trustSignals: [
            'Best prices in Tampa',
            'Family-owned since 2010',
            'Satisfaction guarantee',
            'Same-day service available',
          ],
        },
      };
      const out = seedToSectionLines(seed);
      // Everything goes to business_information as a single line.
      const bi = out.business_information.find(l => l.startsWith('Trust signals:'));
      expect(bi).toBeTruthy();
      expect(bi).toContain('Best prices in Tampa');
      expect(bi).toContain('Family-owned since 2010');
      expect(bi).toContain('Satisfaction guarantee');
      expect(bi).toContain('Same-day service available');
      // Pricing card stays focused on actual pricing fields.
      expect(out.pricing_guidance.some(l => l.startsWith('Value / trust signals:'))).toBe(false);
    });

    it('ignores non-string trust signal entries', () => {
      const seed: any = {
        objectionHandling: { trustSignals: ['Real signal', null, 42, '', '   '] },
      };
      const out = seedToSectionLines(seed);
      const bi = out.business_information.find(l => l.startsWith('Trust signals:'));
      expect(bi).toBeTruthy();
      expect(bi).toContain('Real signal');
    });

    it('does not emit a trust-signal line when there are no signals', () => {
      const seed: PlaybookSeed = {
        objectionHandling: { trustSignals: [] },
      };
      const out = seedToSectionLines(seed);
      expect(out.business_information.some(l => l.startsWith('Trust signals:'))).toBe(false);
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

    it('does NOT receive trust-signal lines anymore', () => {
      const seed: PlaybookSeed = {
        pricingGuidance: { pricingModel: 'Hourly' },
        objectionHandling: {
          trustSignals: ['Best prices in town', 'Satisfaction guarantee'],
        },
      };
      const out = seedToSectionLines(seed);
      // Pricing card has only the pricing facts.
      expect(out.pricing_guidance).toEqual(['Pricing model: Hourly.']);
      // Trust signals all in BI.
      const bi = out.business_information.find(l => l.startsWith('Trust signals:'));
      expect(bi).toContain('Best prices in town');
      expect(bi).toContain('Satisfaction guarantee');
    });
  });

  describe('personality_brand_voice — NOT written in V2.5', () => {
    it('does not emit personality_brand_voice content for toneNotes', () => {
      const seed: PlaybookSeed = {
        personalityBrandVoice: {
          toneNotes: 'Friendly, professional, local. Match customer energy.',
        },
      };
      const out = seedToSectionLines(seed) as any;
      expect(out.personality_brand_voice).toBeUndefined();
    });

    it('does not emit personality_brand_voice content for generic trust signals', () => {
      const seed: PlaybookSeed = {
        objectionHandling: {
          trustSignals: ['Fully insured', 'Family-owned since 2010'],
        },
      };
      const out = seedToSectionLines(seed) as any;
      expect(out.personality_brand_voice).toBeUndefined();
    });
  });

  it('exposes exactly 2 supported sections (BI + Pricing)', () => {
    expect(SUPPORTED_SECTIONS).toEqual([
      'business_information',
      'pricing_guidance',
    ]);
  });

  it('NEVER writes to hidden sections — only BI + Pricing', () => {
    const seed: PlaybookSeed = {
      businessInformation: { serviceArea: 'Tampa' },
      pricingGuidance:     { pricingModel: 'Hourly' },
      bookingGuidance:     { bookingChannels: ['Online'] },
      objectionHandling:   { trustSignals: ['Fully insured'] },
      humanHandoffGuidance: { phones: ['555-1212'] },
      personalityBrandVoice: { toneNotes: 'Friendly' },
    };
    const out = seedToSectionLines(seed) as any;
    expect(Object.keys(out).sort()).toEqual([
      'business_information',
      'pricing_guidance',
    ]);
    expect(out.booking_guidance).toBeUndefined();
    expect(out.objection_handling).toBeUndefined();
    expect(out.human_handoff_guidance).toBeUndefined();
    expect(out.personality_brand_voice).toBeUndefined();
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
  });

  it('omits keys for sections with no content', () => {
    const out = seedToCustomInstructions({});
    expect(out.business_information).toBeUndefined();
    expect(out.pricing_guidance).toBeUndefined();
  });

  it('does not return personality_brand_voice key (removed in V2.5)', () => {
    const seed: PlaybookSeed = {
      personalityBrandVoice: { toneNotes: 'Friendly' },
      objectionHandling:     { trustSignals: ['Insured'] },
    };
    const out = seedToCustomInstructions(seed) as any;
    expect(out.personality_brand_voice).toBeUndefined();
  });
});
