/**
 * ServiceProfile preset data — internal seed + fallback only.
 *
 * The customer-facing preset picker and admin Templates page both read
 * from the `service_template_presets` table (see
 * AdminServiceTemplatesService). The two constants in this file
 * (`UPHOLSTERY_FURNITURE_CLEANING_PRESET`, `GENERIC_CUSTOM_SERVICE_PRESET`)
 * are:
 *   1. seeded into that table at boot, so the DB stays the single
 *      source of truth for what tenants see, and
 *   2. used directly by `ServiceProfileService.createBlank` as the
 *      starting shape for "Create custom service" — a fixed shape
 *      that should NOT change when an admin edits the seeded row.
 *
 * Pure data + one factory helper. No Prisma, no DI.
 */

import { ServicePreset } from './service-presets.types';

/**
 * Upholstery and Furniture Cleaning — derived from Thumbtack's setup
 * data (categoryID is not yet exposed to our supply-side scopes; see
 * the support-request draft in MEMORY for the demand-scope ask).
 *
 * Pricing model is `item_quantity` — per-item base price × quantity.
 * The current deterministic engine in src/pricing/ only supports the
 * bed/bath grid. Until item_quantity is added:
 *   - profile.pricingJson is stored verbatim,
 *   - hydratePricing() returns an empty cleaningTypes / priceTable
 *     pair on item_quantity input, so buildPricingPrompt emits NO
 *     reference block,
 *   - quoteBlock is therefore empty — the AI cannot quote a total.
 *
 * Safe AI behavior under that scaffold: defer the total ("the team
 * will confirm exact pricing") OR mention per-item starting prices
 * verbatim, never multiply or sum. The base-hard-rules already
 * enforce "don't quote when missing inputs"; that rule fires here.
 *
 * Curtains has no Thumbtack average — interpolated to $60 (between
 * Ottoman $35 and Loveseat $76). Flagged `source: 'interpolated'`.
 *
 * Stain cleaning add-on has no Thumbtack price — quoteManually=true
 * so a future item_quantity engine will skip it in the calculated
 * total and the AI can only mention that we charge separately.
 */
export const UPHOLSTERY_FURNITURE_CLEANING_PRESET: ServicePreset = {
  key: 'upholstery_furniture_cleaning',
  provider: 'thumbtack',
  providerCategoryName: 'Upholstery and Furniture Cleaning',
  aliases: [
    'upholstery and furniture cleaning',
    'furniture and upholstery cleaning',
    'furniture cleaning',
    'upholstery cleaning',
  ],
  label: 'Upholstery and Furniture Cleaning',
  description:
    'Furniture and upholstery cleaning for sofas, sectionals, chairs, mattresses, curtains, and ottomans.',
  qualificationSchemaJson: {
    questions: [
      {
        key: 'furniture_pieces',
        label: 'Which furniture pieces do you clean?',
        type: 'multi_select',
        options: ['sofa', 'loveseat', 'sectional', 'chair', 'mattress', 'curtains', 'ottoman'],
      },
      {
        key: 'furniture_piece_count',
        label: 'How many furniture pieces do you need cleaned?',
        type: 'single_select',
        options: ['1_piece', '2_pieces', '3_pieces', '4_pieces', '5_pieces'],
      },
      {
        key: 'stain_types',
        label: 'Which types of stains need cleaning?',
        type: 'multi_select',
        options: ['food_stains', 'drink_stains', 'pet_stains', 'oil_grease_stains'],
      },
      {
        key: 'upholstery_material',
        label: 'What type of upholstery material is it?',
        type: 'single_select',
        options: ['microfiber', 'leather', 'cotton', 'polyester', 'linen', 'suede', 'customer_not_sure'],
      },
    ],
  },
  pricingJson: {
    pricingModel: 'item_quantity',
    included: ['Cleaning supplies'],
    items: [
      { key: 'sofa',      label: 'Sofa',      price: 96,  source: 'thumbtack_average', unit: 'per sofa',      active: true },
      { key: 'loveseat',  label: 'Loveseat',  price: 76,  source: 'thumbtack_average', unit: 'per loveseat',  active: true },
      { key: 'chair',     label: 'Chair',     price: 44,  source: 'thumbtack_average', unit: 'per chair',     active: true },
      { key: 'sectional', label: 'Sectional', price: 149, source: 'thumbtack_average', unit: 'per sectional', active: true },
      { key: 'mattress',  label: 'Mattress',  price: 92,  source: 'thumbtack_average', unit: 'per mattress',  active: true },
      { key: 'ottoman',   label: 'Ottoman',   price: 35,  source: 'thumbtack_average', unit: 'per ottoman',   active: true },
      { key: 'curtains',  label: 'Curtains',  price: 60,  source: 'interpolated',      unit: 'per panel',     active: true },
    ],
    addOns: [
      {
        key: 'stain_cleaning',
        label: 'Cleaning stains',
        price: 0,
        source: 'missing_from_thumbtack',
        quoteManually: true,
      },
    ],
  },
  serviceRules: {
    requiredDetails: [
      'Number of seats',
      'Area rug size',
      'Mattress size',
      'Fabric type',
      'Full name',
      'Address',
      'Phone number',
    ],
    unsupportedServices: [
      'Leather cleaning',
      'Wool rug cleaning',
    ],
    workflowSteps: [
      'Greet the customer and confirm the service category',
      'Ask which furniture pieces need cleaning and how many of each',
      'Ask for fabric type — if leather, mark as unsupported and defer to owner',
      'Ask about stain locations and types if any are mentioned',
      'Collect full name, service address, and phone number',
      'Share per-item starting prices verbatim — do NOT compute a total',
      'Confirm a preferred date / time window and hand off to the owner',
    ],
  },
  faqJson: {
    customQA: [
      {
        question: 'What furniture pieces do you clean?',
        answer:
          'We can clean sofas, loveseats, sectionals, chairs, mattresses, curtains, and ottomans.',
      },
      {
        question: 'What stains can you clean?',
        answer:
          'We can help with food stains, drink stains, pet stains, and oil or grease stains. Some stains may require inspection before we can confirm results.',
      },
      {
        question: 'What upholstery materials do you clean?',
        answer:
          'We work with microfiber, leather, cotton, polyester, linen, suede, and other common upholstery materials. If you are not sure what material you have, send a photo or description.',
      },
      {
        question: 'Are cleaning supplies included?',
        answer: 'Yes, standard cleaning supplies are included.',
      },
    ],
  },
};

/**
 * Registry — every preset in the codebase. Keep this small + curated;
 * presets are tenant-facing data, not arbitrary configuration. Adding
 * a new preset is a deliberate PR-level decision.
 */
/**
 * Generic "Custom Service" starter — powers the "Create custom service"
 * flow in AddServiceModal when none of the curated presets match the
 * tenant's actual line of work (roofing, mobile mechanic, photography,
 * etc.). The data here is deliberately neutral:
 *
 *   - hourly pricing model with a $100 laborRate + $100 minimumCharge.
 *     The AI shares those as "starts around $100 / starts around
 *     $100/hour" — never as guaranteed finals. quoteRequired=true
 *     locks the AI into deferring the bound quote until scope is
 *     confirmed with the owner.
 *
 *   - FAQ stays generic: no insurance/license claims, no service-area
 *     promises, no payment-method commitments. The questions exist so
 *     the AI has something to say, but every answer either defers or
 *     asks for more info.
 *
 *   - Qualification asks for the four details we need on any first
 *     contact (phone, address, date, project description) plus optional
 *     photos / ZIP. No service-specific fields — those would be wrong
 *     more often than they'd be right.
 *
 *   - Service rules force the AI to gather scope before quoting and
 *     forbid claims about licensing, insurance, warranty, or
 *     certifications until the tenant explicitly configures them.
 *
 * provider='manual' because there's no platform category to map this
 * to — `suggestPresetForCategory` will never return this preset
 * automatically. Tenants reach it via the explicit "Create custom
 * service" path only.
 */
export const GENERIC_CUSTOM_SERVICE_PRESET: ServicePreset = {
  key: 'generic_custom_service',
  provider: 'manual',
  providerCategoryName: 'Custom Service',
  aliases: [
    'custom service',
    'general home service',
    'other',
  ],
  label: 'Custom Service',
  description:
    'Generic starter template for any local service business. Review pricing, FAQ, and questions before activating.',
  qualificationSchemaJson: {
    questions: [
      { key: 'phone_number', label: 'Phone number', type: 'text', required: true },
      { key: 'service_address', label: 'Service address', type: 'text', required: true },
      { key: 'desired_service_date', label: 'Desired service date', type: 'date', required: true },
      { key: 'project_description', label: 'Project description', type: 'text', required: true },
      { key: 'photos', label: 'Photos (optional)', type: 'text' },
      { key: 'zip_code', label: 'ZIP code (optional)', type: 'text' },
    ],
  },
  pricingJson: {
    pricingModel: 'hourly',
    currency: 'USD',
    laborRate: 100,
    minimumCharge: 100,
    quoteRequired: true,
    notes:
      'Final pricing depends on the scope, complexity, and location of the job.',
  },
  faqJson: {
    customQA: [
      {
        question: 'Do you provide estimates?',
        answer:
          'Yes. Pricing depends on the scope of work, and we can provide an estimate after learning more about your project.',
      },
      {
        question: 'What areas do you serve?',
        answer:
          'We serve the local area and nearby communities. Please provide your address or ZIP code so we can confirm availability.',
      },
      {
        question: 'How soon can service be scheduled?',
        answer:
          'Availability varies based on demand. Let us know your preferred date and we will confirm available times.',
      },
      {
        question: 'What payment methods do you accept?',
        answer:
          'We accept most common payment methods. Final payment options can be confirmed when scheduling.',
      },
      {
        question: 'Are you insured and licensed?',
        answer:
          'Licensing and insurance requirements vary by service. Please contact us for details about coverage and credentials.',
      },
      {
        question: 'Does someone need to be on-site?',
        answer:
          'Requirements vary by service. We will confirm access instructions during scheduling.',
      },
    ],
  },
  serviceRules: {
    requiredDetails: [
      'Short description of the project',
      'Service address or ZIP code',
      'Desired service date',
      'Photos if they would help estimate the work',
    ],
    unsupportedServices: [],
    workflowSteps: [
      'Greet the customer and ask what service they need',
      'Ask for a short description of the project',
      'Ask for the service address or ZIP code',
      'Ask for the desired service date',
      'Ask for photos if they would help estimate the work',
      'Share the starting labor rate as guidance, not as a guaranteed quote',
      'Do not guarantee a final price until scope is confirmed',
      'Do not claim licensing, insurance, warranty, or certifications unless explicitly configured by the business',
      'Confirm a preferred date / time window and hand off to the owner',
    ],
  },
};

/**
 * Inputs the factory needs to build a ServiceProfile create payload.
 * Kept narrow so callers don't have to construct the whole Prisma
 * input shape — this just decides "what fields the profile gets from
 * the preset" and leaves DB concerns to the caller.
 */
export type BuildProfileFromPresetOpts = {
  userId: string;
  /** Override the default slug (preset.key with underscores → dashes). */
  slug?: string;
  /** Override the status. Default 'draft' so the operator must promote it. */
  status?: 'draft' | 'active';
  /** Pre-existing mapping entries to merge with the preset's defaults. */
  extraCategoryMappings?: Array<{ provider: 'thumbtack' | 'yelp' | 'manual'; providerCategoryId?: string; categoryName?: string }>;
};

/**
 * Build a ServiceProfile creation payload from a preset. Pure — does
 * NOT touch Prisma. Returns the shape the caller would pass to
 * `prisma.serviceProfile.create({ data: ... })`.
 *
 * The new profile defaults to `status: 'draft'` so the operator must
 * explicitly promote it to active before the resolver's aiPaused
 * short-circuit stops gating leads. Until then, leads matching this
 * profile's mappings get the existing "AI paused" behavior — no
 * silent activation.
 */
export function buildServiceProfileFromPreset(
  preset: ServicePreset,
  opts: BuildProfileFromPresetOpts,
): {
  userId: string;
  name: string;
  slug: string;
  status: 'draft' | 'active';
  isDefault: false;
  providerCategoryMappingsJson: unknown;
  pricingJson: string;
  faqJson: string;
  qualificationSchemaJson: string;
  aiInstructionsJson: string | null;
} {
  const slug = opts.slug ?? preset.key.replace(/_/g, '-');
  const mappings = [
    {
      provider: preset.provider,
      categoryName: preset.providerCategoryName,
    },
    ...(opts.extraCategoryMappings ?? []),
  ];
  // Wrapper shape for aiInstructionsJson — `version: 1` flags this as a
  // post-v1 envelope so the playbook renderer can disambiguate it from
  // the legacy "raw V2 sections at top level" shape. v1 only carries
  // serviceRules; future fields (e.g. profile-level aiPlaybookV2
  // sections) slot in here without another shape migration.
  const aiInstructionsJson = preset.serviceRules
    ? JSON.stringify({ version: 1, serviceRules: preset.serviceRules })
    : null;
  return {
    userId: opts.userId,
    name: preset.label,
    slug,
    status: opts.status ?? 'draft',
    isDefault: false,
    providerCategoryMappingsJson: mappings,
    pricingJson: JSON.stringify(preset.pricingJson),
    faqJson: JSON.stringify(preset.faqJson),
    qualificationSchemaJson: JSON.stringify(preset.qualificationSchemaJson),
    aiInstructionsJson,
  };
}

