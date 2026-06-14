/**
 * ServiceSchemaService
 *
 * Step-1 accumulator: turns inbound Thumbtack lead payloads into a
 * per-category questionnaire catalog stored in the `service_schemas`
 * table. We never call a new TT endpoint — every field consumed here
 * already arrives in `request.category.name` + `request.details[]` on
 * every NegotiationCreatedV4 webhook (see thumbtack.adapter.ts:382 and
 * ai.controller.ts:402-408 for prior consumers of the same payload).
 *
 * Hard contract:
 *  - mergeFromThumbtackPayload MUST never throw — webhook handlers call
 *    it fire-and-forget. Any failure is swallowed + warn-logged.
 *  - All writes happen inside a single transaction so concurrent webhooks
 *    racing on the same (category, source) tuple do not lose questions.
 *  - Per-question dedup is by `normalizeQuestionKey(label)`. The first-
 *    seen label is preserved verbatim for display.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import type { Prisma } from '../../generated/prisma';
import {
  ServiceSchemaQuestion,
  coerceAnswerToOptions,
  normalizeQuestionKey,
} from './service-schema.types';

type ThumbtackMergeInput = {
  /** Raw negotiation payload (parsed object OR JSON string from Lead.rawJson). */
  rawPayload: unknown;
  /** Observation timestamp. Defaults to now. Backfill passes the lead's createdAt. */
  observedAt?: Date;
};

type ThumbtackMergeResult =
  | { status: 'skipped'; reason: 'no_category' | 'no_payload' | 'parse_error' | 'no_details' }
  | { status: 'merged'; categoryName: string; questionsAdded: number; optionsAdded: number; created: boolean };

@Injectable()
export class ServiceSchemaService {
  private readonly logger = new Logger(ServiceSchemaService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Fire-and-forget wrapper for webhook callers — never throws.
   * Use this from webhooks.service.ts; use mergeFromThumbtackPayload
   * directly from backfill scripts where you want the result back.
   */
  async mergeFromThumbtackPayloadSafe(input: ThumbtackMergeInput): Promise<void> {
    try {
      const result = await this.mergeFromThumbtackPayload(input);
      if (result.status === 'merged') {
        this.logger.debug(
          `[service-schema] merged category="${result.categoryName}" ` +
          `questionsAdded=${result.questionsAdded} optionsAdded=${result.optionsAdded} ` +
          `created=${result.created}`,
        );
      }
    } catch (err: any) {
      // Webhook path — must not surface. Log and move on.
      this.logger.warn(`[service-schema] merge failed: ${err?.message ?? err}`);
    }
  }

  /**
   * Idempotent-ish merge: each call increments observationsCount by 1,
   * appends any new questions/options seen in `rawPayload`, and bumps
   * lastSeenAt. Safe to re-run on the same payload — duplicate options
   * are deduplicated, and observationsCount intentionally counts every
   * call (the caller decides whether to merge once-per-lead).
   */
  async mergeFromThumbtackPayload(input: ThumbtackMergeInput): Promise<ThumbtackMergeResult> {
    const observedAt = input.observedAt ?? new Date();

    if (input.rawPayload == null) {
      return { status: 'skipped', reason: 'no_payload' };
    }

    let parsed: any;
    if (typeof input.rawPayload === 'string') {
      try {
        parsed = JSON.parse(input.rawPayload);
      } catch {
        return { status: 'skipped', reason: 'parse_error' };
      }
    } else {
      parsed = input.rawPayload;
    }

    const request = parsed?.request ?? {};
    const categoryName: string = typeof request?.category?.name === 'string'
      ? request.category.name.trim()
      : '';
    if (!categoryName) {
      return { status: 'skipped', reason: 'no_category' };
    }

    const details: any[] = Array.isArray(request?.details) ? request.details : [];

    // Even when `details` is empty we still upsert the row — that bumps
    // top-level observationsCount + lastSeenAt so operators can see
    // which categories we observe leads in vs. which categories have
    // question discovery happening. Per-question merging just no-ops
    // through the loop below when there are no questions.

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.serviceSchema.findUnique({
        where: {
          provider_providerCategoryName_source: {
            provider: 'thumbtack',
            providerCategoryName: categoryName,
            source: 'webhook_accumulator',
          },
        },
      });

      const questions: ServiceSchemaQuestion[] = existing
        ? toQuestionArray(existing.questionsJson)
        : [];

      let questionsAdded = 0;
      let optionsAdded = 0;
      const observedAtIso = observedAt.toISOString();

      for (const item of details) {
        const rawLabel = typeof item?.question === 'string' ? item.question.trim() : '';
        if (!rawLabel) continue;

        const key = normalizeQuestionKey(rawLabel);
        if (!key) continue;

        let q = questions.find((x) => x.key === key);
        if (!q) {
          q = {
            key,
            label: rawLabel,
            type: 'observed_select',
            options: [],
            observationsCount: 0,
            lastSeenAt: null,
          };
          questions.push(q);
          questionsAdded += 1;
        }
        q.observationsCount = (q.observationsCount ?? 0) + 1;
        q.lastSeenAt = observedAtIso;

        for (const opt of coerceAnswerToOptions(item?.answer)) {
          if (!q.options.includes(opt)) {
            q.options.push(opt);
            optionsAdded += 1;
          }
        }
      }

      if (existing) {
        await tx.serviceSchema.update({
          where: { id: existing.id },
          data: {
            questionsJson: questions as unknown as Prisma.InputJsonValue,
            observationsCount: existing.observationsCount + 1,
            lastSeenAt: observedAt,
          },
        });
        return {
          status: 'merged' as const,
          categoryName,
          questionsAdded,
          optionsAdded,
          created: false,
        };
      }

      await tx.serviceSchema.create({
        data: {
          provider: 'thumbtack',
          providerCategoryName: categoryName,
          source: 'webhook_accumulator',
          sourceConfidence: 'partial',
          questionsJson: questions as unknown as Prisma.InputJsonValue,
          observationsCount: 1,
          lastSeenAt: observedAt,
        },
      });
      return {
        status: 'merged' as const,
        categoryName,
        questionsAdded,
        optionsAdded,
        created: true,
      };
    });
  }

  /**
   * Read API for the admin endpoint. Returns a compact projection — full
   * `questionsJson` is included so the operator can inspect what's been
   * accumulated, but the heavy fields stay out of any list summary view.
   */
  async listByProvider(provider: string): Promise<Array<{
    id: string;
    provider: string;
    providerCategoryName: string;
    source: string;
    sourceConfidence: string;
    observationsCount: number;
    questionsCount: number;
    lastSeenAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    questions: ServiceSchemaQuestion[];
  }>> {
    const rows = await this.prisma.serviceSchema.findMany({
      where: { provider },
      orderBy: [{ lastSeenAt: 'desc' }, { providerCategoryName: 'asc' }],
    });
    return rows.map((row) => {
      const questions = toQuestionArray(row.questionsJson);
      return {
        id: row.id,
        provider: row.provider,
        providerCategoryName: row.providerCategoryName,
        source: row.source,
        sourceConfidence: row.sourceConfidence,
        observationsCount: row.observationsCount,
        questionsCount: questions.length,
        lastSeenAt: row.lastSeenAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        questions,
      };
    });
  }
}

/**
 * Defensive cast: Prisma's Json type comes back as `Prisma.JsonValue`,
 * which is `string | number | boolean | null | JsonObject | JsonArray`.
 * If the column ever holds a malformed shape (e.g. a manual SQL edit)
 * we want the accumulator to start fresh on this row rather than crash.
 */
function toQuestionArray(raw: unknown): ServiceSchemaQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: ServiceSchemaQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.key !== 'string' || typeof r.label !== 'string') continue;
    out.push({
      key: r.key,
      label: r.label,
      type: r.type === 'unknown' ? 'unknown' : 'observed_select',
      options: Array.isArray(r.options) ? r.options.filter((x): x is string => typeof x === 'string') : [],
      observationsCount: typeof r.observationsCount === 'number' ? r.observationsCount : 0,
      lastSeenAt: typeof r.lastSeenAt === 'string' ? r.lastSeenAt : null,
    });
  }
  return out;
}
