/**
 * Lightweight in-memory counter for events that aren't persisted in the DB.
 *
 * Currently used for LeadStatusService skip reasons (sf_protected,
 * pipeline_downgrade, etc.) — those guards short-circuit before writing an
 * audit row, so the only way to count them is to track them here as they fire.
 *
 * Behaviour:
 *  - Stores epoch-ms timestamps per key in a bounded ring buffer.
 *  - countLastHour(key) trims and returns the count of hits in the last 3600s.
 *  - Resets on process restart. Acceptable for single-instance LeadBridge;
 *    if we ever scale horizontally, swap this for Redis or a Postgres counter.
 *
 * No external metrics endpoint, no Prometheus — these counts are surfaced via
 * GET /v1/integrations/health.
 */

import { Injectable } from '@nestjs/common';

const ONE_HOUR_MS = 60 * 60 * 1000;
const MAX_RING_SIZE = 5000;

@Injectable()
export class IntegrationMetricsService {
  private readonly hits = new Map<string, number[]>();

  recordSkip(reason: string): void {
    this.bump(`skip:${reason}`);
  }

  countLastHour(key: string): number {
    const arr = this.hits.get(key);
    if (!arr || arr.length === 0) return 0;
    const cutoff = Date.now() - ONE_HOUR_MS;
    // Trim in place — all timestamps are appended in order.
    let firstFresh = 0;
    while (firstFresh < arr.length && arr[firstFresh] < cutoff) firstFresh++;
    if (firstFresh > 0) arr.splice(0, firstFresh);
    return arr.length;
  }

  countSkipLastHour(reason: string): number {
    return this.countLastHour(`skip:${reason}`);
  }

  private bump(key: string): void {
    const arr = this.hits.get(key) ?? [];
    arr.push(Date.now());
    if (arr.length > MAX_RING_SIZE) arr.splice(0, arr.length - MAX_RING_SIZE);
    this.hits.set(key, arr);
  }
}
