/**
 * Type definitions for the ServiceProfile preset registry.
 *
 * A preset is a curated bundle of pricing + FAQ + qualification schema
 * for one platform-side service category (e.g. "Upholstery and
 * Furniture Cleaning"). Tenants opt in by creating a ServiceProfile
 * from the preset — at that point each preset field is copied into the
 * corresponding ServiceProfile column verbatim.
 *
 * Presets are READ-ONLY data: never mutated at runtime, never tied to
 * a specific tenant. The runtime path stays unchanged — the resolver
 * reads ServiceProfile rows the same way regardless of whether they
 * were authored by hand, backfilled from a SavedAccount, or created
 * from a preset.
 */

/** Source attribution per item — drives the UI "where this number came from" tag. */
export type PricingSource =
  | 'thumbtack_average'      // platform-published average price for this item
  | 'interpolated'           // we picked the number ourselves to fill a hole
  | 'missing_from_thumbtack' // no price data exists; ask owner / quote manually
  | 'manual';                // tenant-authored override

/** Field types the qualification UI knows how to render. */
export type QuestionType =
  | 'multi_select'
  | 'single_select'
  | 'text'
  | 'number'
  | 'date';

export type PresetQuestion = {
  /** Stable machine key — never user-facing. */
  key: string;
  /** Customer-facing label. */
  label: string;
  type: QuestionType;
  /** Required for select types; omitted for text/number/date. */
  options?: string[];
  /** Default false. UI uses this to gate "submit". */
  required?: boolean;
};

export type PresetQualificationSchema = {
  questions: PresetQuestion[];
};

/**
 * Pricing model — discriminator for the deterministic pricing engine.
 *
 *   bed_bath_grid  — house cleaning grid: { bed, bath, sqftMin, sqftMax }
 *                    rows × cleaningType columns. This is what the
 *                    current pricing engine in src/pricing/ supports.
 *
 *   item_quantity  — upholstery / furniture / handyman: per-item base
 *                    price × quantity. Not yet supported by the
 *                    deterministic engine — see TODO in the upholstery
 *                    preset comment for the safe AI fallback contract.
 *
 *   flat_rate      — single price (cleanouts, simple jobs).
 */
export type PricingModel = 'bed_bath_grid' | 'item_quantity' | 'flat_rate';

export type PresetItemPrice = {
  key: string;
  label: string;
  price: number;
  source: PricingSource;
};

export type PresetAddOnPrice = {
  key: string;
  label: string;
  price: number;
  source: PricingSource;
  /**
   * True when the platform did not publish a price for this add-on
   * and we don't want the AI to invent one. The deterministic engine
   * (when it gains item_quantity support) MUST skip these in the
   * calculated quote — AI is allowed to mention the line item exists
   * but must defer the number to the owner.
   */
  quoteManually?: boolean;
};

export type PresetPricing = {
  pricingModel: PricingModel;
  /** Free-text descriptions of what's bundled. Renders in the AI prompt. */
  included?: string[];
  /** Per-item base prices (item_quantity model). */
  items?: PresetItemPrice[];
  /** Add-ons that customers can layer onto the base order. */
  addOns?: PresetAddOnPrice[];
};

/**
 * FAQ shape mirrors the runtime AccountFaq contract in
 * src/ai/faq-context.ts — the `customQA` array is the slot the FAQ
 * renderer walks. Storing in this shape lets a tenant create a
 * profile from preset and have the runtime path pick up the answers
 * with zero conversion.
 */
export type PresetFaq = {
  customQA: Array<{ question: string; answer: string }>;
};

export type ServicePreset = {
  /** Stable registry key — used by tenants / UI / lookupByKey. */
  key: string;
  /** Provider this preset's data was sourced from. */
  provider: 'thumbtack' | 'yelp' | 'manual';
  /**
   * Verbatim category name as it appears on the provider. Drives
   * suggestPresetForCategory when a tenant connects an account; also
   * used as the default ServiceProfile.providerCategoryMappingsJson
   * mapping entry at profile-create time.
   */
  providerCategoryName: string;
  /**
   * Additional category names this preset should match against (any
   * order, case-insensitive). E.g. "Furniture Cleaning" and
   * "Upholstery Cleaning" both suggest the upholstery preset.
   */
  aliases: string[];
  /** UI label for the preset card. */
  label: string;
  /** Short description for the preset card / hover. */
  description: string;
  qualificationSchemaJson: PresetQualificationSchema;
  pricingJson: PresetPricing;
  faqJson: PresetFaq;
};
