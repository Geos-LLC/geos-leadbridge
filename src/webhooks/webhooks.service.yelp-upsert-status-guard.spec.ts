/**
 * Regression test — Donna RCA 2026-05-08.
 *
 * The Yelp inbound webhook uses `prisma.lead.upsert` to create-or-update the
 * Lead row for the incoming event. Historically the `update:` branch wrote
 * `status: leadData.status || undefined`, where `leadData.status` came from
 * the Yelp adapter's `data.ilq?.status || 'new'` — i.e. Yelp's internal
 * lifecycle string, NOT an LB-canonical status.
 *
 * Effect: every webhook event on an existing terminal lead silently reverted
 * `lead.status` away from `lost` / `booked` / `completed`, with no audit row,
 * no SSE, no logger output. Donna's lead exhibited the partial state
 * `status='new', lostReason='hired_someone'` because of this.
 *
 * The fix is to remove the `status:` field from the upsert's `update:` branch.
 * Real platform-status changes must go through
 * `LeadStatusService.writeStatus({ source: 'platform_sync' })` so the
 * canonical-status guards (HARD_TERMINAL, pipeline-downgrade, completed-lock,
 * sf_protected, dedup) all run.
 *
 * This test asserts the source code shape directly because the buggy line was
 * a single-character omission that wouldn't be caught by behavioral tests
 * without significant DI scaffolding. The lb-status-guard script
 * (`scripts/check-lead-status-writes.js`) provides the same defense at
 * pre-commit time; this test fails loudly inside the regular Jest run as
 * belt-and-suspenders.
 */

import * as fs from 'fs';
import * as path from 'path';

interface UpsertCall {
  /** Absolute char offset of the `this.prisma.lead.upsert` token start. */
  startIdx: number;
  /** 1-based line number of the call start. */
  lineNo: number;
  /** Inner body of the call (between the outermost parens). */
  body: string;
}

function findAllUpsertCalls(src: string): UpsertCall[] {
  const out: UpsertCall[] = [];
  const re = /this\.prisma\.lead\.upsert\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const tokenStart = m.index;
    const open = m.index + m[0].length - 1; // position of '('
    let depth = 1;
    let i = open + 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    const body = src.slice(open + 1, i - 1);
    const lineNo = src.slice(0, tokenStart).split('\n').length;
    out.push({ startIdx: tokenStart, lineNo, body });
  }
  return out;
}

function findYelpUpsert(src: string): UpsertCall {
  const all = findAllUpsertCalls(src);
  const yelpOnly = all.filter((c) => /platform\s*:\s*['"]yelp['"]/.test(c.body));
  if (yelpOnly.length === 0) {
    throw new Error('Yelp this.prisma.lead.upsert call not found');
  }
  if (yelpOnly.length > 1) {
    throw new Error(
      `Expected exactly one Yelp this.prisma.lead.upsert call; found ${yelpOnly.length}. ` +
        'If a second one was intentionally added, update this test to cover both.',
    );
  }
  return yelpOnly[0];
}

function extractObjectBlock(src: string, headerRe: RegExp): string {
  const m = headerRe.exec(src);
  if (!m) throw new Error(`block not found for header: ${headerRe}`);
  const open = m.index + m[0].length - 1; // position of '{'
  let depth = 1;
  let i = open + 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  if (depth !== 0) throw new Error('unbalanced braces extracting block');
  return src.slice(open + 1, i - 1);
}

describe('Yelp lead.upsert — status field guard (Donna RCA)', () => {
  const sourcePath = path.resolve(__dirname, 'webhooks.service.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');

  it('contains exactly one Yelp lead.upsert call (any new ones must update this guard)', () => {
    const all = findAllUpsertCalls(source);
    const yelpOnly = all.filter((c) => /platform\s*:\s*['"]yelp['"]/.test(c.body));
    expect(yelpOnly.length).toBe(1);
  });

  it('Yelp upsert `update:` branch does NOT contain a status field (regression: Donna 2026-05-08)', () => {
    const yelp = findYelpUpsert(source);
    const updateBlock = extractObjectBlock(yelp.body, /\bupdate\s*:\s*\{/);
    // Match `status:` at any depth inside the update block. Tolerant of
    // surrounding whitespace and quoted keys; matches the same regex the
    // lb-status-guard script uses.
    const statusFieldRe = /(?:^|[\s,{])(['"]?)status\1\s*:/m;
    expect(statusFieldRe.test(updateBlock)).toBe(false);
  });

  it('Yelp upsert `create:` branch may still set status: as INSERT default', () => {
    // The create branch is a row-birth default and is explicitly exempt via
    // the lb-status-guard marker comment above the upsert call. Confirm the
    // exemption is still doing the right thing — i.e. status IS set on create
    // (otherwise newly-arriving Yelp leads would be created with NULL status,
    // which would break downstream queries).
    const yelp = findYelpUpsert(source);
    const createBlock = extractObjectBlock(yelp.body, /\bcreate\s*:\s*\{/);
    const statusFieldRe = /(?:^|[\s,{])(['"]?)status\1\s*:/m;
    expect(statusFieldRe.test(createBlock)).toBe(true);
  });

  it('the lb-status-guard exemption marker is present above the Yelp upsert call', () => {
    // If the marker is removed, the lb-status-guard script will refuse the
    // create-branch status: and CI will fail. Confirm the marker is still in
    // place so the guard doesn't false-positive after this fix.
    const yelp = findYelpUpsert(source);
    const lines = source.split('\n');
    // Marker should appear within the 10 lines preceding the upsert call.
    const upsertLineIdx = yelp.lineNo - 1; // 0-based
    const window = lines.slice(Math.max(0, upsertLineIdx - 10), upsertLineIdx).join('\n');
    expect(window).toContain('lb-status-guard: allow Yelp webhook lead-creation');
  });
});
