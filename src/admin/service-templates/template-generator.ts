/**
 * Template generator orchestrator — composes the three deterministic
 * parsers into one GeneratedTemplate.
 *
 * Why a separate file (vs. inlining in the service): keeps the pure
 * compute boundary clean. The generator never touches Prisma, JWT, or
 * any framework — it just transforms text → JSON. The tests rely on
 * that (no DI, no mocks).
 */

import {
  GeneratedTemplate,
  GeneratorSourceJson,
} from './admin-service-templates.types';
import { parseServiceOptions } from './parsers/service-options-parser';
import { parsePricing } from './parsers/pricing-parser';
import { generateCustomerAnswers } from './parsers/customer-answers-generator';
import { parseFaq } from './parsers/faq-parser';

/** Bump if the parser output shape changes — lets us re-run later
 *  against the same source text and produce updated JSON. */
export const GENERATOR_VERSION = 1;

export type GenerateInput = {
  /** Display name the admin gave the template. */
  serviceName: string;
  /** 'thumbtack' | 'yelp' | 'manual' — admin picks from a dropdown. */
  provider: string;
  /** Verbatim provider category name. */
  providerCategoryName: string;
  /** Provider category id when available — Thumbtack doesn't expose it
   *  on supply-side scopes today, so this stays optional. */
  providerCategoryId?: string | null;
  /** Optional admin-facing notes. Stored in sourceJson. */
  notes?: string | null;
  /** Raw Service Options text the admin pasted. */
  rawOptionsText: string;
  /** Raw Pricing text the admin pasted. */
  rawPricingText: string;
  /** Raw FAQ text the admin pasted. Optional — when omitted/empty the
   *  generator emits `faqJson = {customQA: []}` and the create endpoint
   *  leaves the DB column null. */
  rawFaqText?: string;
};

/** Generate a stable key from the service name. Same logic as the
 *  options parser's toKey but capped longer (templates are long-lived). */
function generateKey(serviceName: string, provider: string): string {
  const cleaned = serviceName
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, ' ')
    .replace(/[\s_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  const base = cleaned || 'template';
  // Prefix with provider so two templates with the same name across
  // providers don't collide on the unique index.
  return `${provider}_${base}`;
}

/**
 * Main entry point. Pure — does NOT call the DB. The service layer is
 * responsible for persisting whatever the admin reviews + edits.
 */
export function generateTemplate(input: GenerateInput): GeneratedTemplate {
  const serviceOptionsJson = parseServiceOptions(input.rawOptionsText);
  const pricingJson = parsePricing(input.rawPricingText);
  const customerAnswersJson = generateCustomerAnswers(serviceOptionsJson, pricingJson);
  const faqJson = parseFaq(input.rawFaqText ?? '');

  const sourceJson: GeneratorSourceJson = {
    kind: 'admin_generated',
    provider: input.provider,
    rawOptionsText: input.rawOptionsText,
    rawPricingText: input.rawPricingText,
    rawFaqText: input.rawFaqText ?? '',
    notes: input.notes ?? undefined,
    generatorVersion: GENERATOR_VERSION,
    generatedAt: new Date().toISOString(),
  };

  return {
    key: generateKey(input.serviceName, input.provider),
    label: input.serviceName,
    provider: input.provider,
    providerCategoryName: input.providerCategoryName,
    providerCategoryId: input.providerCategoryId ?? null,
    description: null,
    serviceOptionsJson,
    pricingJson,
    customerAnswersJson,
    faqJson,
    sourceJson,
  };
}
