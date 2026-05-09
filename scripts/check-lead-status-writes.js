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
    const callKind = m[2]; // 'update' | 'updateMany' | 'upsert'

    // Look for `status:` at any depth inside the call arg. Be tolerant of
    // surrounding whitespace and quoted keys.
    const statusFieldRe = /(?:^|[\s,{])(['"]?)status\1\s*:/m;
    if (!statusFieldRe.test(callArg)) continue;

    // Compute line number of the call start.
    const upTo = src.slice(0, callStart);
    const lineNo = upTo.split('\n').length;

    // For upsert calls, the `update:` branch is a runtime status WRITE that
    // bypasses LeadStatusService — the same class of bug as a bare update().
    // Reject `status:` in the update-branch unconditionally; the exemption
    // marker only covers the `create:` branch (INSERT default at row birth).
    // See Donna RCA 2026-05-08 — Yelp webhook upsert silently reverted
    // canonical terminals before this guard was tightened.
    if (callKind === 'upsert') {
      const updateBlock = extractObjectBlock(callArg, /\bupdate\s*:\s*\{/);
      if (updateBlock && statusFieldRe.test(updateBlock)) {
        VIOLATIONS.push({
          file: rel,
          line: lineNo,
          snippet: '<upsert update branch writes Lead.status — must go through LeadStatusService>',
          kind: 'upsert_update_branch',
        });
        continue;
      }
      // Fall through: status only in `create:` branch — exemption marker handles it below.
    }

    // Check the call site for the exemption marker. The window covers:
    //   - up to 6 lines BEFORE the call (block comments may span multiple lines)
    //   - the call line itself (trailing comment)
    //   - the entire call body (in case the marker is on the data block)
    // Operators must add the marker explicitly so it shows up in code review.
    const lines = src.split('\n');
    const startLine = Math.max(0, lineNo - 7); // 6 lines before, 0-indexed
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

/**
 * Find the body of a named object property inside `src`, e.g. `update: { ... }`.
 * Returns the inner block text (without the surrounding braces) or null when
 * the property is absent. Brace-balanced: handles nested objects.
 */
function extractObjectBlock(src, headerRe) {
  const m = headerRe.exec(src);
  if (!m) return null;
  const openIdx = m.index + m[0].length - 1; // position of '{'
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  if (depth !== 0) return null; // unbalanced — let the outer scan handle it
  return src.slice(openIdx + 1, i - 1);
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
    console.error(`    ${v.snippet}`);
    if (v.kind === 'upsert_update_branch') {
      console.error('    (upsert.update branch — NOT exemptable; route real status changes through LeadStatusService.writeStatus(source: \'platform_sync\').)');
    }
    console.error('');
  }
  console.error('Every Lead.status write must go through LeadStatusService.writeStatus().');
  console.error(`If this write is genuinely unavoidable, add an inline comment with the marker:`);
  console.error(`    // ${EXEMPT_MARKER} <one-line justification>`);
  console.error('and request explicit approval in the PR.');
  console.error('Note: the exemption marker covers the `create:` branch of an upsert (INSERT default)');
  console.error('but does NOT cover the `update:` branch — that always requires LeadStatusService.\n');
  process.exit(1);
}

console.log('[lead-status-guard] OK — no direct Lead.status writes detected outside LeadStatusService.');
process.exit(0);
