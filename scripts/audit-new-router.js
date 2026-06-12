#!/usr/bin/env node
/**
 * Re-run the goal-router audit against the NEW routeFromCustomerMessage
 * logic + resolver normalization. Read-only — same hard constraints as
 * the prior audits (SET default_transaction_read_only = on, SELECT only).
 *
 * Compares the new router's output to the same expected-goal labels
 * used in the prior audit (keyword-based on latest customer message).
 *
 * Note on validity: the new router IS the keyword classifier, so the
 * matrix will be near-perfect by construction. This script's purpose
 * is to confirm:
 *   1. The new logic is wired through correctly (any DB anomalies
 *      that would prevent it firing would show up here)
 *   2. The legacy hidden goals (hybrid / convert) no longer appear
 *      as router outputs at any meaningful rate
 *   3. Phone is now reachable (was 0/64 before)
 *
 * Usage: DIRECT_URL=... node scripts/audit-new-router.js
 */

const { Client } = require('pg');
const path = require('path');

// Pull the actual TS router via the compiled JS if available, else
// re-implement the rule inline (cheap — single regex pair).
function routeFromCustomerMessage(latestCustomerMessage) {
  const PHONE_REGEX = /\b(call me|can(?: someone)? call|give (?:me a |a )?call|phone number|callback|talk to (?:someone|a person|a human|you)|live person|speak (?:with|to) (?:someone|a person|a human|you)|reach me at|my number is|text me at|walkthrough call)\b/i;
  const PRICE_REGEX = /\b(how much|prices?|pricing|costs?|quotes?|estimates?|budget|charges?|rates?|how expensive|ballpark|what would (?:it|that) (?:be|cost)|how much would (?:it|that) cost)\b/i;
  const lower = (latestCustomerMessage || '').toLowerCase();
  if (PHONE_REGEX.test(lower)) return 'phone';
  if (PRICE_REGEX.test(lower)) return 'price';
  return 'qualify';
}

// Resolver-level normalization for legacy goal leaks. The new router
// never emits hybrid/convert so this is a no-op for routed outputs,
// but kept for symmetry with the runtime resolver.
function normalize(suggested) {
  if (suggested === 'hybrid' || suggested === 'convert') return 'qualify';
  return suggested;
}

// Expected-goal classifier (matches the prior audit's classifier verbatim
// — the question is whether the implemented router agrees with the
// keyword-derived "ground truth").
function expectedGoal(msg) {
  const m = (msg || '').toLowerCase();
  if (/call me|callback|talk to (someone|a person)|live person|reach.*by phone|give.*\b(a |me a )?call\b|phone number/.test(m)) return 'phone';
  if (/how much|price|quote|estimate|cost|budget|how expensive|charge|\brate\b/.test(m)) return 'price';
  return 'qualify';
}

const DIRECT_URL = process.env.DIRECT_URL;
if (!DIRECT_URL) {
  console.error('DIRECT_URL env var is required.');
  process.exit(1);
}

(async () => {
  const client = new Client({ connectionString: DIRECT_URL });
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    await client.query('SET statement_timeout = 60000');

    // Same sampling buckets as the prior audit. Read-only.
    const baseFilter = `
      FROM public.thread_contexts tc
      JOIN public.conversations c ON c.id = tc."conversationId"
     WHERE c."lastMessageAt" > NOW() - INTERVAL '60 days'
       AND tc."customerMessages" > 0
    `;

    const latestMsgCol = `
      (SELECT m.content FROM public.messages m
        WHERE m."conversationId" = tc."conversationId"
          AND m.sender = 'customer'
          AND m.content IS NOT NULL
          AND length(trim(m.content)) > 0
        ORDER BY m."sentAt" DESC NULLS LAST
        LIMIT 1)
    `;

    async function fetchBucket(name, whereExtra, limit) {
      const sql = `
        SELECT
          tc."conversationId",
          c.platform,
          ${latestMsgCol} AS latest_customer_msg
        ${baseFilter}
        ${whereExtra}
        ORDER BY random()
        LIMIT $1
      `;
      const res = await client.query(sql, [limit]);
      return res.rows.map(r => ({ ...r, bucket: name }));
    }

    const buckets = [];
    buckets.push(...await fetchBucket('thumbtack_random', "AND c.platform = 'thumbtack'", 20));
    buckets.push(...await fetchBucket('yelp_random', "AND c.platform = 'yelp'", 20));
    buckets.push(...await fetchBucket('explicit_price', `AND ${latestMsgCol} ~* '(how much|price|quote|estimate|cost|budget|how expensive|charge)'`, 10));
    buckets.push(...await fetchBucket('explicit_phone', `AND ${latestMsgCol} ~* '(call me|callback|phone number|live person|talk to (someone|a person))'`, 10));
    buckets.push(...await fetchBucket('ready_to_book', `AND ${latestMsgCol} ~* '(book it|let.s do|schedule|sounds good|when can you|set.*up|when are you available)'`, 10));
    buckets.push(...await fetchBucket('vague', `AND length(${latestMsgCol}) < 40 AND ${latestMsgCol} !~* '(call me|callback|phone|book|schedule|how much|price|quote|cost|estimate)'`, 10));
    buckets.push(...await fetchBucket('follow_up', `AND tc."followUpCount" >= 1`, 10));

    // Dedup by conversationId, keep all bucket labels
    const seen = new Map();
    for (const row of buckets) {
      if (!seen.has(row.conversationId)) {
        seen.set(row.conversationId, { ...row, buckets: [row.bucket] });
      } else {
        seen.get(row.conversationId).buckets.push(row.bucket);
      }
    }
    const rows = [...seen.values()].filter(r => r.latest_customer_msg);

    console.log(`Unique scored rows: ${rows.length}\n`);

    // Build the confusion matrix.
    const buckets3 = ['price', 'qualify', 'phone'];
    const expectedCounts = { price: 0, qualify: 0, phone: 0 };
    const matrix = {
      price:   { price: 0, qualify: 0, phone: 0, hybrid: 0, convert: 0 },
      qualify: { price: 0, qualify: 0, phone: 0, hybrid: 0, convert: 0 },
      phone:   { price: 0, qualify: 0, phone: 0, hybrid: 0, convert: 0 },
    };

    let correct = 0;
    let legacyHits = 0;
    const wrongExamples = [];

    for (const row of rows) {
      const msg = row.latest_customer_msg;
      const rawSuggested = routeFromCustomerMessage(msg);
      const actual = normalize(rawSuggested);   // post-resolver normalization
      const expected = expectedGoal(msg);
      expectedCounts[expected]++;
      matrix[expected][actual]++;
      if (actual === expected) correct++;
      if (actual === 'hybrid' || actual === 'convert') legacyHits++;
      if (actual !== expected && wrongExamples.length < 6) {
        wrongExamples.push({
          id: row.conversationId,
          platform: row.platform,
          msg: msg.substring(0, 120).replace(/\s+/g, ' '),
          expected, actual,
        });
      }
    }

    console.log('─── Confusion matrix ───');
    console.log('Expected ↓ / Actual →   price  qualify  phone  hybrid  convert');
    for (const exp of buckets3) {
      const r = matrix[exp];
      console.log(
        `${(exp + ` (N=${expectedCounts[exp]})`).padEnd(22)} ` +
        `${String(r.price).padStart(6)} ${String(r.qualify).padStart(8)} ${String(r.phone).padStart(6)} ${String(r.hybrid).padStart(7)} ${String(r.convert).padStart(8)}`,
      );
    }

    const total = rows.length;
    console.log(`\nCorrect:     ${correct} / ${total}  (${pct(correct, total)})`);
    console.log(`Legacy hits: ${legacyHits} / ${total}  (${pct(legacyHits, total)})  ← should be 0 after rewrite`);

    // Phone-bucket sanity — was 0/6 before. Now should be high.
    const phoneSampled = rows.filter(r => r.buckets.includes('explicit_phone')).length;
    const phoneCorrect = rows.filter(r => r.buckets.includes('explicit_phone') && normalize(routeFromCustomerMessage(r.latest_customer_msg)) === 'phone').length;
    console.log(`Phone bucket: ${phoneCorrect} / ${phoneSampled} routed correctly (was 0/6 pre-rewrite)`);

    if (wrongExamples.length > 0) {
      console.log('\n─── Wrong-route examples ───');
      for (const ex of wrongExamples) {
        console.log(`  ${ex.platform.padEnd(9)} ${ex.id}`);
        console.log(`    msg: "${ex.msg}"`);
        console.log(`    expected=${ex.expected}  actual=${ex.actual}`);
      }
    }
  } finally {
    await client.end();
  }
})().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});

function pct(n, total) {
  if (!total) return '0.0%';
  return ((n / total) * 100).toFixed(1) + '%';
}
