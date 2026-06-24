/**
 * Deterministic FAQ parser — raw text → `faqJson` shape.
 *
 * Mirrors the pricing pattern: admin pastes loosely-structured text in
 * the editor, this parser converts it to the JSON shape the AI runtime
 * actually reads. Admin can then hand-tune the generated JSON before
 * saving.
 *
 * Recognized blocks (case-insensitive, headings end with optional `:`):
 *
 *   Regular Cleaning Includes:    (aliases: Standard Scope, Regular Scope,
 *                                  Standard Cleaning, What's Included Regular)
 *     - Dust all surfaces
 *     - Vacuum and mop
 *
 *   Deep Cleaning Includes:       (aliases: Deep Scope, Deep Cleaning,
 *                                  What's Included Deep)
 *     - Everything in regular
 *     - Inside oven
 *
 *   Q: How is pricing calculated?
 *   A: We base it on bedrooms, bathrooms, and extras.
 *
 *   Q: Do you bring supplies?
 *   A: Yes — standard supplies are included.
 *
 * Output:
 *   {
 *     standardScope: "Dust all surfaces\nVacuum and mop",
 *     deepScope: "Everything in regular\nInside oven",
 *     customQA: [
 *       { question: "How is pricing calculated?", answer: "..." },
 *       { question: "Do you bring supplies?",     answer: "..." }
 *     ]
 *   }
 *
 * Pure — no I/O, no exceptions. Same input always produces the same
 * output.
 */

import { FaqJson } from '../admin-service-templates.types';

type BlockKind = 'standard_scope' | 'deep_scope' | 'qa' | null;

const STANDARD_SCOPE_HEADINGS = [
  'regular cleaning includes',
  'regular cleaning',
  'regular scope',
  'standard cleaning includes',
  'standard cleaning',
  'standard scope',
  "what's included regular",
  'whats included regular',
  "what's included in regular",
  'whats included in regular',
];

const DEEP_SCOPE_HEADINGS = [
  'deep cleaning includes',
  'deep cleaning',
  'deep scope',
  "what's included deep",
  'whats included deep',
  "what's included in deep",
  'whats included in deep',
];

/** Strip a leading `- `, `* `, `• `, or `1.` style bullet from a list line. */
function stripBullet(line: string): string {
  return line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
}

/** Returns the block kind if `line` is a recognized heading, else null. */
function detectHeading(line: string): BlockKind {
  const cleaned = line.trim().toLowerCase().replace(/[:\-–]+$/, '').trim();
  if (!cleaned) return null;
  if (STANDARD_SCOPE_HEADINGS.includes(cleaned)) return 'standard_scope';
  if (DEEP_SCOPE_HEADINGS.includes(cleaned)) return 'deep_scope';
  return null;
}

/** Matches `Q:`, `Question:`, `q.` etc at the start of a line. */
const Q_PREFIX = /^\s*(?:q|question)\s*[:.\-]\s*/i;
const A_PREFIX = /^\s*(?:a|answer)\s*[:.\-]\s*/i;

export function parseFaq(rawText: string): FaqJson {
  const out: FaqJson = { customQA: [] };
  if (!rawText || typeof rawText !== 'string') return out;

  const lines = rawText.split(/\r?\n/);

  let mode: BlockKind = null;
  const standardLines: string[] = [];
  const deepLines: string[] = [];

  // Q/A pair accumulator. Once we see a `Q:` we keep collecting answer
  // lines until the next `Q:` / heading / EOF.
  let currentQ: string | null = null;
  let currentA: string[] = [];

  const flushQA = () => {
    if (currentQ && currentQ.length > 0) {
      const answer = currentA.join(' ').replace(/\s+/g, ' ').trim();
      out.customQA.push({ question: currentQ, answer });
    }
    currentQ = null;
    currentA = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();

    if (!trimmed) {
      // Blank line ends an in-flight Q/A only when we already have one;
      // scope blocks tolerate blank lines mid-list.
      if (mode === 'qa') flushQA();
      continue;
    }

    const heading = detectHeading(trimmed);
    if (heading) {
      flushQA();
      mode = heading;
      continue;
    }

    if (Q_PREFIX.test(trimmed)) {
      flushQA();
      mode = 'qa';
      currentQ = trimmed.replace(Q_PREFIX, '').trim();
      continue;
    }

    if (mode === 'qa' && A_PREFIX.test(trimmed)) {
      currentA.push(trimmed.replace(A_PREFIX, '').trim());
      continue;
    }

    if (mode === 'standard_scope') {
      const item = stripBullet(trimmed);
      if (item) standardLines.push(item);
      continue;
    }
    if (mode === 'deep_scope') {
      const item = stripBullet(trimmed);
      if (item) deepLines.push(item);
      continue;
    }
    if (mode === 'qa' && currentQ) {
      // Continuation of an unprefixed multi-line answer.
      currentA.push(trimmed);
      continue;
    }
    // Lines before any recognized heading are ignored — admin can hand-
    // edit the JSON if they want to capture something the parser missed.
  }

  flushQA();

  if (standardLines.length > 0) out.standardScope = standardLines.join('\n');
  if (deepLines.length > 0) out.deepScope = deepLines.join('\n');

  return out;
}
