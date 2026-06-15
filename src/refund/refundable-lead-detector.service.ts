/**
 * Refundable-lead duplicate detector.
 *
 * Surfaces Thumbtack leads that *look* refundable per TT's duplicate
 * rule: same tenant, same TT customer identity, same business, same
 * category, same ZIP, similar request, created within 45 days of an
 * earlier paid lead. Inserts a `RefundableLeadFlag` row with evidence;
 * the UI derives a "Possibly refundable" badge from
 *   validUntil > now AND Lead.refundedAt IS NULL.
 *
 * Status taxonomy: NONE. The flag is active or expired. Confirmed
 * refunds remain Lead.refundedAt-driven (set by the existing sweep +
 * 404 handler). When refundedAt lands, the UI shows the existing
 * "Refunded" badge instead — RefundableLeadFlag rows are NOT mutated.
 *
 * Crons:
 *   - `runDuplicateDetection`: hourly, advisory lock 7006. Scans
 *     recent leads for duplicates and upserts flags. Idempotent —
 *     the `@@unique([leadId, ruleId])` constraint makes re-runs
 *     no-op.
 *   - `pruneExpiredFlags`: daily, advisory lock 7007. Deletes
 *     flags where validUntil < now - 90 days (per spec).
 *
 * The detection rule itself is exposed as a pure static function
 * (`matchesDuplicateRule`) so the acceptance tests can verify each
 * condition without a Prisma round trip.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/utils/prisma.service';
import { withCronLock, isSkipped } from '../common/utils/cron-lock';
import { normalizePhoneE164 } from '../common/utils/phone-normalize';
import { jaccardSimilarity } from '../common/utils/text-similarity';

const RULE_ID = 'duplicate_within_45_days';
const RULE_VERSION = 'v1';

/** Jaccard threshold per operator spec: ≥ 0.5 to flag. */
const JACCARD_THRESHOLD = 0.5;

/** TT's refund window. Flags expire at `lead.createdAt + 45 days`. */
const VALID_DAYS = 45;

/** How long to keep dormant flags around for audit before pruning. */
const PRUNE_AFTER_DAYS = 90;

/** Scan window — leads older than this never run through the detector. */
const SCAN_WINDOW_DAYS = 90;

/** Per-tick cap on how many leads we examine. Hourly tick keeps total
 *  detection load bounded; tenants with many fresh leads catch up over a
 *  few hours. */
const BATCH_SIZE = 200;

export interface DuplicateRuleInputs {
  /** The lead under inspection. */
  lead: LeadFields;
  /** A potential earlier paid lead from the same tenant. */
  candidate: LeadFields;
}

interface LeadFields {
  id: string;
  userId: string;
  businessId: string | null;
  category: string | null;
  postcode: string | null;
  customerPhone: string | null;
  customerPhoneSubstitute?: string | null;
  message: string | null;
  createdAt: Date;
  rawJson?: string | null;
  chargeStateRaw?: string | null;
}

export interface DuplicateRuleResult {
  match: boolean;
  confidence: 'high' | 'medium' | null;
  reason?:
    | 'different_tenant'
    | 'no_customer_identity_match'
    | 'no_business_match'
    | 'no_category_match'
    | 'no_postcode_match'
    | 'outside_window'
    | 'same_lead'
    | 'candidate_already_refunded'
    | 'request_dissimilar';
  jaccard?: number;
  matchedField?: 'phone' | 'customer_id';
}

/**
 * Pure rule: does `lead` look like a duplicate of `candidate` per TT's
 * 45-day rule? Returns the full decision + reason for the test harness.
 *
 * Order matters — we short-circuit on the cheapest exclusions first so
 * the detector can scan large windows without doing Jaccard math on every
 * lead pair.
 */
export function matchesDuplicateRule({ lead, candidate }: DuplicateRuleInputs): DuplicateRuleResult {
  // Cheap structural checks first.
  if (lead.id === candidate.id) return { match: false, confidence: null, reason: 'same_lead' };
  if (lead.userId !== candidate.userId) {
    return { match: false, confidence: null, reason: 'different_tenant' };
  }
  if (!lead.businessId || lead.businessId !== candidate.businessId) {
    return { match: false, confidence: null, reason: 'no_business_match' };
  }
  if (!lead.category || lead.category !== candidate.category) {
    return { match: false, confidence: null, reason: 'no_category_match' };
  }
  if (!lead.postcode || lead.postcode !== candidate.postcode) {
    return { match: false, confidence: null, reason: 'no_postcode_match' };
  }
  // Time window — within 45 days either direction. The detector typically
  // runs lead-against-earlier, but `abs` keeps the rule symmetric.
  const daysDelta = Math.abs(lead.createdAt.getTime() - candidate.createdAt.getTime()) / 86_400_000;
  if (daysDelta > VALID_DAYS) return { match: false, confidence: null, reason: 'outside_window' };

  // Customer identity — phone OR TT customerID. Name is NEVER sufficient
  // per spec. We don't have a structured TT customerID column; we read
  // it from rawJson.customer.customerID when present.
  let matchedField: 'phone' | 'customer_id' | null = null;

  const leadPhone = normalizePhoneE164(lead.customerPhone) || normalizePhoneE164(lead.customerPhoneSubstitute);
  const candPhone = normalizePhoneE164(candidate.customerPhone) || normalizePhoneE164(candidate.customerPhoneSubstitute);
  if (leadPhone && candPhone && leadPhone === candPhone) {
    matchedField = 'phone';
  } else {
    const leadCustId = extractTtCustomerId(lead.rawJson);
    const candCustId = extractTtCustomerId(candidate.rawJson);
    if (leadCustId && candCustId && leadCustId === candCustId) {
      matchedField = 'customer_id';
    }
  }
  if (!matchedField) {
    return { match: false, confidence: null, reason: 'no_customer_identity_match' };
  }

  // Candidate must have been paid (the customer-protection rule: TT only
  // refunds leads the pro actually paid for). Treat `Gone` and `Refunded`
  // as already-resolved — they shouldn't reseed a Refundable flag.
  const cs = (candidate.chargeStateRaw ?? '').toLowerCase();
  if (cs === 'refunded' || cs === 'gone') {
    return { match: false, confidence: null, reason: 'candidate_already_refunded' };
  }

  // Final gate — request similarity.
  const jaccard = jaccardSimilarity(lead.message, candidate.message);
  if (jaccard < JACCARD_THRESHOLD) {
    return { match: false, confidence: null, reason: 'request_dissimilar', jaccard, matchedField };
  }

  return {
    match: true,
    confidence: jaccard >= 0.7 ? 'high' : 'medium',
    matchedField,
    jaccard,
  };
}

/**
 * Extract `customer.customerID` from a TT lead's rawJson, when present.
 * Returns null on parse failure or absent field — caller treats null as
 * "no customer-ID match available; fall back to phone".
 */
function extractTtCustomerId(rawJson: string | null | undefined): string | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson);
    const id = parsed?.customer?.customerID;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

@Injectable()
export class RefundableLeadDetectorService {
  private readonly logger = new Logger(RefundableLeadDetectorService.name);
  private readonly schedulerEnabled: boolean;

  constructor(private readonly prisma: PrismaService) {
    // Reuses the same env switch as the follow-up scheduler so staging
    // stays out of the loop when prod is the authoritative writer.
    this.schedulerEnabled = process.env.FOLLOWUP_SCHEDULER !== 'false';
  }

  @Cron(CronExpression.EVERY_HOUR)
  async runDuplicateDetection(): Promise<void> {
    if (!this.schedulerEnabled) return;
    await withCronLock(
      this.prisma,
      this.logger,
      7006,
      'RefundableLeadDetector',
      (tx) => this.scanOnce(tx as unknown as PrismaService),
      { timeoutMs: 180_000 },
    );
  }

  /**
   * One scan pass — exposed as a method (not just inline in the cron) so
   * the spec can drive it deterministically without ticking the cron.
   */
  async scanOnce(tx: PrismaService): Promise<{ examined: number; flagged: number }> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - SCAN_WINDOW_DAYS * 86_400_000);

    // Pick recent TT leads that don't already have an active flag for
    // this rule. The exclusion is a partial join — done in JS after the
    // findMany so we don't depend on Prisma supporting `none` against
    // partial indexes.
    const leads = await tx.lead.findMany({
      where: {
        platform: 'thumbtack',
        createdAt: { gte: windowStart },
        // Already-refunded leads don't need a Refundable flag; the UI
        // shows "Refunded" instead.
        refundedAt: null,
        externalRequestId: { not: '' },
      },
      select: {
        id: true,
        userId: true,
        businessId: true,
        category: true,
        postcode: true,
        customerPhone: true,
        customerPhoneSubstitute: true,
        message: true,
        rawJson: true,
        chargeStateRaw: true,
        createdAt: true,
      },
      take: BATCH_SIZE,
      orderBy: { createdAt: 'desc' },
    });

    if (leads.length === 0) return { examined: 0, flagged: 0 };

    // Bulk-fetch existing flags for these leads so we can skip ones that
    // already have a flag (idempotent re-run).
    const existing = await tx.refundableLeadFlag.findMany({
      where: { leadId: { in: leads.map((l) => l.id) }, ruleId: RULE_ID },
      select: { leadId: true },
    });
    const alreadyFlagged = new Set(existing.map((e) => e.leadId));

    let examined = 0;
    let flagged = 0;
    for (const lead of leads) {
      if (alreadyFlagged.has(lead.id)) continue;
      examined++;

      // Find candidate leads within the same tenant + account + category
      // + ZIP, in the time window. The composite indexes on Lead make
      // this query a quick range scan.
      const candidates = await tx.lead.findMany({
        where: {
          userId: lead.userId,
          businessId: lead.businessId,
          category: lead.category,
          postcode: lead.postcode,
          id: { not: lead.id },
          createdAt: {
            gte: new Date(lead.createdAt.getTime() - VALID_DAYS * 86_400_000),
            lte: new Date(lead.createdAt.getTime() + VALID_DAYS * 86_400_000),
          },
        },
        select: {
          id: true,
          userId: true,
          businessId: true,
          category: true,
          postcode: true,
          customerPhone: true,
          customerPhoneSubstitute: true,
          message: true,
          rawJson: true,
          chargeStateRaw: true,
          createdAt: true,
        },
        take: 50,
      });

      for (const candidate of candidates) {
        const result = matchesDuplicateRule({ lead, candidate });
        if (!result.match || !result.confidence) continue;

        // Insert the flag.
        const leadPrice = extractLeadPrice(lead.rawJson);
        const summary = buildEvidenceSummary({
          lead,
          candidate,
          matchedField: result.matchedField!,
          jaccard: result.jaccard!,
          candidateLeadPrice: extractLeadPrice(candidate.rawJson),
        });
        const evidenceJson = JSON.stringify({
          ruleVersion: RULE_VERSION,
          duplicateLeadId: candidate.id,
          matchedField: result.matchedField,
          jaccard: Number(result.jaccard!.toFixed(3)),
          leadCost: leadPrice,
          candidateLeadCost: extractLeadPrice(candidate.rawJson),
          daysDelta: Math.round(
            Math.abs(lead.createdAt.getTime() - candidate.createdAt.getTime()) / 86_400_000,
          ),
        });

        try {
          await tx.refundableLeadFlag.create({
            data: {
              leadId: lead.id,
              userId: lead.userId,
              ruleId: RULE_ID,
              confidence: result.confidence,
              evidenceSummary: summary,
              evidenceJson,
              detectedAt: new Date(),
              // validUntil = lead.createdAt + 45 days so the flag's
              // lifetime exactly matches TT's refund window.
              validUntil: new Date(lead.createdAt.getTime() + VALID_DAYS * 86_400_000),
            },
          });
          flagged++;
        } catch (err: any) {
          // Race-aware: the @@unique([leadId, ruleId]) constraint may
          // have been hit by a concurrent run. Treat as already-flagged.
          if (err?.code === 'P2002') continue;
          this.logger.warn(`[RefundableLeadDetector] insert failed for lead ${lead.id}: ${err.message}`);
        }
        // First match wins — don't double-flag a lead against multiple
        // candidates. The evidence points at one duplicate; future rule
        // versions can show all duplicates if needed.
        break;
      }
    }

    if (examined > 0) {
      this.logger.log(`[RefundableLeadDetector] examined=${examined} flagged=${flagged}`);
    }
    return { examined, flagged };
  }

  /**
   * Prune flags whose validUntil expired more than `PRUNE_AFTER_DAYS`
   * ago. Spec: keep dormant flags for 90 days after expiration for
   * audit, then delete.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async pruneExpiredFlags(): Promise<void> {
    if (!this.schedulerEnabled) return;
    const outcome = await withCronLock(
      this.prisma,
      this.logger,
      7007,
      'RefundableLeadFlagPrune',
      async (tx) => {
        const cutoff = new Date(Date.now() - PRUNE_AFTER_DAYS * 86_400_000);
        const res = await (tx as unknown as PrismaService).refundableLeadFlag.deleteMany({
          where: { validUntil: { lt: cutoff } },
        });
        return res.count;
      },
      { timeoutMs: 60_000 },
    );
    if (!isSkipped(outcome) && (outcome as number) > 0) {
      this.logger.log(`[RefundableLeadDetector] pruned ${outcome} expired flags`);
    }
  }
}

/** Mask a phone for display in the evidence summary (operator-facing). */
function maskPhone(phone: string | null | undefined): string {
  const norm = normalizePhoneE164(phone);
  if (!norm) return 'unknown';
  // "+15551234567" → "+1 ••• ••• 4567"
  const tail = norm.slice(-4);
  return `••• ••• ${tail}`;
}

/** Format the human-readable evidence sentence shown in the popover. */
function buildEvidenceSummary(args: {
  lead: LeadFields;
  candidate: LeadFields;
  matchedField: 'phone' | 'customer_id';
  jaccard: number;
  candidateLeadPrice: number | null;
}): string {
  const earlier = args.lead.createdAt < args.candidate.createdAt ? args.candidate : args.lead;
  const dateStr = earlier.createdAt.toISOString().slice(0, 10);
  const idSrc =
    args.matchedField === 'phone'
      ? `phone ${maskPhone(args.lead.customerPhone || args.lead.customerPhoneSubstitute)}`
      : 'same Thumbtack customer';
  const pct = Math.round(args.jaccard * 100);
  return (
    `Duplicate of lead from ${dateStr} — ${idSrc}, ` +
    `same category (${args.lead.category ?? 'unknown'}), same ZIP ${args.lead.postcode ?? 'unknown'}, ` +
    `request ${pct}% similar.`
  );
}

/** Pull `leadPrice` (TT cost) from rawJson, parsed to number. */
function extractLeadPrice(rawJson: string | null | undefined): number | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson);
    const raw = parsed?.leadPrice;
    if (typeof raw !== 'string') return null;
    const n = parseFloat(raw.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
