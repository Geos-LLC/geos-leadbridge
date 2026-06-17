/**
 * Type definitions for the admin Service Template builder.
 *
 * These shapes mirror — but are deliberately NOT identical to — the
 * existing `ServicePreset` registry types in
 * src/service-profile/presets/service-presets.types.ts.
 *
 * Why a separate type tree:
 *  - The V2 spec renames `faqJson` → `customerAnswersJson` and replaces
 *    the structured `serviceRules` with a single free-text
 *    `additionalInstructions` string. The code-side registry keeps the
 *    old shape (it backs already-published curated presets); the
 *    admin-DB shape is the new contract going forward.
 *  - Source attribution (`thumbtack_average` | `admin_input` |
 *    `interpolated` | `missing`) differs slightly from the code-side
 *    `PricingSource` union (`thumbtack_average` | `interpolated` |
 *    `missing_from_thumbtack` | `manual`). We don't unify the two —
 *    legacy registry entries keep their tags, and admin-generated rows
 *    carry the new ones. Both convert to the same runtime pricing model
 *    when copied into a ServiceProfile.
 *
 * Nothing here touches Prisma — pure data types. The service layer
 * (admin-service-templates.service.ts) is the only place that imports
 * `@prisma/client`.
 */

// ── Service Options ────────────────────────────────────────────────

/**
 * Single vs multi-select inference is intentionally conservative.
 * Heuristics in the parser:
 *   - "Which method / which one / which size" → single_select
 *   - "Which types / Which add-ons" (plural) → multi_select
 *   - Numeric ranges like "How many rooms" → single_select
 * Fallback for anything else is `multi_select` so customers can pick
 * combinations safely (over-asking is recoverable; under-asking is not).
 */
export type ServiceOptionGroupType = 'single_select' | 'multi_select';

export type ServiceOptionItem = {
  /** Stable snake_case identifier. Stays the same even if the label is renamed in the UI. */
  key: string;
  /** Customer-facing label — preserved verbatim from the input text. */
  label: string;
};

export type ServiceOptionGroup = {
  /** Stable snake_case identifier derived from the heading line. */
  key: string;
  /** Customer-facing prompt label — verbatim from input. */
  label: string;
  type: ServiceOptionGroupType;
  options: ServiceOptionItem[];
};

export type ServiceOptionsJson = {
  groups: ServiceOptionGroup[];
};

// ── Pricing ────────────────────────────────────────────────────────

/**
 * Five v1 pricing models. `custom` is the explicit "we couldn't infer"
 * bucket — the parser sets pricingModel='custom' + quoteRequired=true
 * so the AI defers any quote until an operator authors something
 * concrete.
 */
export type AdminPricingModel =
  | 'item_quantity'
  | 'room_quantity'
  | 'hourly'
  | 'flat_rate'
  | 'custom';

/**
 * Where a specific number came from. Drives the "source" badge in the
 * preview UI so admins can see at a glance which rows need review.
 *  - 'thumbtack_average' — admin pasted a "Avg. $X" line
 *  - 'admin_input'       — admin pasted a "$X" line without average prefix
 *  - 'interpolated'      — the parser inferred a number from neighbours
 *  - 'missing'           — no price in the source text → quoteManually=true
 */
export type AdminPricingSource =
  | 'thumbtack_average'
  | 'admin_input'
  | 'interpolated'
  | 'missing';

export type AdminBasePrice = {
  /** Numeric quantity if the row was "N rooms / N items". Null for flat lines. */
  quantity: number | null;
  /** Verbatim row label (e.g. "1 room", "Sofa"). */
  label: string;
  /** Numeric price — 0 when source='missing'. */
  price: number;
  source: AdminPricingSource;
};

export type AdminAddOn = {
  key: string;
  label: string;
  /** 0 when no price in source text. */
  price: number;
  /** Defaults to true when the add-on line had no number — AI must defer
   *  the quote to the owner rather than invent one. */
  quoteManually?: boolean;
  source: AdminPricingSource;
};

export type AdminPricingJson = {
  pricingModel: AdminPricingModel;
  /** ISO 4217 — defaults to 'USD'. */
  currency: string;
  /** Per-quantity rows. Used by item_quantity + room_quantity models. */
  basePrices: AdminBasePrice[];
  /** Add-ons that can layer onto the base order. */
  addOns: AdminAddOn[];
  /** Hourly: labor rate per hour. Only meaningful when pricingModel='hourly'. */
  laborRate?: number;
  /** Hourly + flat_rate: the floor admins want the AI to share. */
  minimumCharge?: number;
  /** When true, AI may share base numbers as guidance but must defer
   *  any total to the owner. Auto-true on `custom` and `hourly`. */
  quoteRequired?: boolean;
  /** Free-text caveat printed alongside the rate. Optional. */
  notes?: string;
};

// ── Customer Answers (was FAQ) ─────────────────────────────────────

export type CustomerAnswerEntry = {
  question: string;
  answer: string;
};

export type CustomerAnswersJson = {
  entries: CustomerAnswerEntry[];
};

// ── Source attribution ─────────────────────────────────────────────

/**
 * Audit trail stored on every admin-generated row. Lets us re-run the
 * parser against the original text later (when the parser improves)
 * and lets the UI display "Generated 3 days ago from Thumbtack input."
 */
export type GeneratorSourceJson = {
  kind: 'admin_generated';
  provider: string;
  rawOptionsText: string;
  rawPricingText: string;
  /** Optional admin-authored notes pasted alongside the inputs. */
  notes?: string;
  /** Bumps when the deterministic parser changes shape. v1 is 1. */
  generatorVersion: number;
  /** ISO-8601 UTC stamp — set by the generator, never trusted from client input. */
  generatedAt: string;
};

// ── Generator output envelope ──────────────────────────────────────

/**
 * What `POST /v1/admin/service-templates/generate` returns. Pure compute
 * — the controller never persists this. Admin reviews, edits, then
 * calls the create endpoint with the final shape.
 */
export type GeneratedTemplate = {
  key: string;
  label: string;
  provider: string;
  providerCategoryName: string;
  providerCategoryId: string | null;
  description: string | null;
  serviceOptionsJson: ServiceOptionsJson;
  pricingJson: AdminPricingJson;
  customerAnswersJson: CustomerAnswersJson;
  additionalInstructions: string | null;
  sourceJson: GeneratorSourceJson;
};

// ── Public-facing preset row (for the merged picker) ───────────────

/**
 * Shape `GET /v1/service-profile-presets` returns for DB-sourced rows.
 * The picker can ignore the discriminator and read whichever JSON
 * shape it understands (admin templates use the v2 keys, code presets
 * use the v1 keys — the picker stayed forward-compatible because all
 * are JSON blobs).
 */
export type PublicTemplatePreset = {
  source: 'admin_template';
  templateId: string;
  key: string;
  label: string;
  provider: string;
  providerCategoryName: string;
  providerCategoryId: string | null;
  description: string | null;
  serviceOptionsJson: ServiceOptionsJson;
  pricingJson: AdminPricingJson;
  customerAnswersJson: CustomerAnswersJson;
  additionalInstructions: string | null;
};
