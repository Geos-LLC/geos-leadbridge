#!/usr/bin/env node
/**
 * Merge-blocking guard: every write to `Lead.status` must go through
 * `LeadStatusService.writeStatus`. Direct `prisma.lead.update(...)` /
 * `prisma.lead.updateMany(...)` calls that include `status:` are rejected.
 *
 * Exemptions:
 *   - The file that owns the centralized path:
 *       src/leads/lead-status.service.ts
 *   - Any line carrying the marker comment:
 *       // lb-status-guard: allow <reason>
 *
 * Run from repo root:
 *   node scripts/check-lead-status-writes.js
 *
 * Exits 1 on violations, 0 on clean.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'src');
const ALLOWLIST = new Set([
  // The single legitimate writer.
  'src/leads/lead-status.service.ts',
]);
const EXEMPT_MARKER = 'lb-status-guard: allow';

const VIOLATIONS = [];

/**
 * Walk a file looking for `prisma.lead.update(...)` or `prisma.lead.updateMany(...)`
 * calls whose argument object contains a `status:` field. Approach:
 *   1. Locate the start of an update call by regex.
 *   2. Walk forward, balancing parentheses, to capture the full call arg.
 *   3. Inside that arg, look for a top-level `status:` (i.e. inside the
 *      `data:` object). We accept any `status:` at any depth — false
 *      positives here are addressed by the exemption marker.
 */
function scanFile(absPath) {
  const rel = path.relative(path.resolve(__dirname, '..'), absPath).split(path.sep).join('/');
  if (ALLOWLIST.has(rel)) return;
  if (rel.endsWith('.spec.ts') || rel.endsWith('.test.ts')) return;
  if (!rel.endsWith('.ts')) return;

  const src = fs.readFileSync(absPath, 'utf8');

  // Match `prisma.lead.update(` and `prisma.lead.updateMany(` (also tx
  // variants like `tx.lead.update(`). Allow whitespace + chained access.
  const re = /\b(prisma|tx|client|db|trx)\.lead\.(update|updateMany|upsert)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const callStart = m.index + m[0].length - 1; // position of '('
    // Find matching ')'
    let depth = 1;
    let i = callStart + 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    const callArg = src.slice(callStart + 1, i - 1);

    // Look for `status:` at any depth inside the call arg. Be tolerant of
    // surrounding whitespace and quoted keys.
    const statusFieldRe = /(?:^|[\s,{])(['"]?)status\1\s*:/m;
    if (!statusFieldRe.test(callArg)) continue;

    // Compute line number of the call start.
    const upTo = src.slice(0, callStart);
    const lineNo = upTo.split('\n').length;

    // Check the call site for the exemption marker. The window covers:
    //   - up to 3 lines BEFORE the call (where // comments typically sit)
    //   - the call line itself (trailing comment)
    //   - the entire call body (in case the marker is on the data block)
    // Operators must add the marker explicitly so it shows up in code review.
    const lines = src.split('\n');
    const startLine = Math.max(0, lineNo - 4); // 3 lines before, 0-indexed
    const endLineIdx = src.slice(0, i).split('\n').length;
    const block = lines.slice(startLine, endLineIdx).join('\n');
    if (block.includes(EXEMPT_MARKER)) continue;

    VIOLATIONS.push({
      file: rel,
      line: lineNo,
      snippet: block.split('\n')[0].trim().slice(0, 140),
    });
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip generated + node_modules
      if (entry.name === 'node_modules' || entry.name === 'generated' || entry.name === 'dist') continue;
      walk(full);
    } else if (entry.isFile()) {
      scanFile(full);
    }
  }
}

walk(ROOT);

if (VIOLATIONS.length > 0) {
  console.error('\n[lead-status-guard] ❌ Direct Lead.status writes detected outside LeadStatusService:\n');
  for (const v of VIOLATIONS) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.snippet}\n`);
  }
  console.error('Every Lead.status write must go through LeadStatusService.writeStatus().');
  console.error(`If this write is genuinely unavoidable, add an inline comment with the marker:`);
  console.error(`    // ${EXEMPT_MARKER} <one-line justification>`);
  console.error('and request explicit approval in the PR.\n');
  process.exit(1);
}

console.log('[lead-status-guard] OK — no direct Lead.status writes detected outside LeadStatusService.');
process.exit(0);
