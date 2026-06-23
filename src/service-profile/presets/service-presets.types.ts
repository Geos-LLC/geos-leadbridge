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
 *
 *   hourly         — labor-rate + minimum-charge. Used by the generic
 *                    "Custom Service" preset that powers the "Create
 *                    custom service" flow when no provider category
 *                    matches. The deterministic engine does NOT quote
 *                    finals from this shape; the AI shares the rate as
 *                    guidance ("starts around $X/hour") and defers the
 *                    bound number to the owner until scope is confirmed.
 */
export type PricingModel = 'bed_bath_grid' | 'item_quantity' | 'flat_rate' | 'hourly';

export type PresetItemPrice = {
  key: string;
  label: string;
  price: number;
  source: PricingSource;
  /** UI hint — e.g. "per sofa", "per piece". Optional; not part of pricing math. */
  unit?: string;
  /** Free-text caveat shown next to the price row. Optional. */
  notes?: string;
  /** Default true. Inactive items stay in the data but the UI hides them from quotes. */
  active?: boolean;
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
  /** ISO currency code — defaults to USD when omitted. Used by the
   *  hourly model and any future flat-rate quoter. */
  currency?: string;
  /** Hourly labor rate the AI surfaces as "starts around $X/hour". Only
   *  meaningful when pricingModel === 'hourly'. */
  laborRate?: number;
  /** Floor the AI may quote — "most projects start around $X". Only
   *  meaningful when pricingModel === 'hourly' or 'flat_rate'. */
  minimumCharge?: number;
  /** When true, the AI MUST NOT present any number as a guaranteed
   *  final price; it shares the rate/floor as guidance and routes the
   *  bound quote to the owner. Defaults to true for hourly. */
  quoteRequired?: boolean;
  /** Free-text caveat shown alongside the rate ("Final pricing depends
   *  on scope, complexity, and location"). Used by the hourly model. */
  notes?: string;

  // ----- bed_bath_grid fields (house cleaning) -----
  // Shape mirrors ServicePricing in src/users/pricing-hydrate.ts so the
  // preset can be stored verbatim and consumed by hydratePricing without
  // a conversion layer.
  /** Top-level routing for legacy frontend code paths. Always 'cleaning' for grid. */
  serviceType?: string;
  /** Cleaning type columns (regular, deep, airbnb, ...) shown on the grid. */
  cleaningTypes?: Array<{ key: string; label: string; enabled?: boolean }>;
  /** Bed/bath rows × cleaningType column prices. */
  priceTable?: Array<Record<string, any>>;
  sqftAdjustEnabled?: boolean;
  frequencyDiscounts?: Array<{ key: string; label: string; discount: number }>;
  extras?: Array<{ key: string; label: string; price: number }>;
  conditionSurcharges?: Array<{ key: string; label: string; surcharge: number }>;
  petSurcharge?: number;
  orderDiscounts?: Array<{ minAmount: number; discount: number }>;
  recurringDiscount?: number;
  priceRange?: { minus: { type: '%' | '$'; value: number }; plus: { type: '%' | '$'; value: number } };
  priceQuoteMode?: 'range' | 'exact';
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
  /** Free-text describing what's included in a regular / standard clean.
   *  Cleaning presets only; surfaced verbatim in the AI prompt's FAQ
   *  block so the AI can answer "what's in a regular cleaning?". */
  standardScope?: string;
  /** Free-text describing what's included in a deep / initial clean. */
  deepScope?: string;
};

/**
 * Service rules — operator-authored guardrails the AI must follow for
 * this service category. v1 is read-only / display-only on the
 * frontend; the runtime injector lands in a follow-up PR (PR-B/PR-C).
 *
 *  - requiredDetails: information the AI must collect before quoting
 *    (e.g. "Number of seats", "Fabric type"). Display-list, no schema.
 *  - unsupportedServices: things this provider does NOT do (e.g.
 *    "Leather cleaning"). The AI should defer to the owner rather
 *    than promise the work.
 *  - workflowSteps: the ordered playbook the AI should walk through
 *    on each lead. Free text; no machine semantics in v1.
 *
 * Stored verbatim into the new ServiceProfile.aiInstructionsJson
 * wrapper (see buildServiceProfileFromPreset). Today it does NOT
 * change the AI prompt — the wrapper key is ignored by the existing
 * playbook renderer until PR-B adds explicit injection.
 */
export type PresetServiceRules = {
  requiredDetails: string[];
  unsupportedServices: string[];
  workflowSteps: string[];
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
  /** Optional v1 — service-specific operator guardrails. See PresetServiceRules. */
  serviceRules?: PresetServiceRules;
};
