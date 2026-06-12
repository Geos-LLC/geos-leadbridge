#!/usr/bin/env node
/**
 * Read-only counterfactual audit of the priceDiscussed sticky flag in
 * suggestStrategy(). Connects to prod, runs SELECT-only queries with
 * SET default_transaction_read_only = on, and reports:
 *
 *   HELPED       — flag turned a wrong route into a correct one
 *   HURT         — flag turned a correct route into a wrong one
 *   NEUTRAL_GOOD — both versions correct (flag irrelevant)
 *   NEUTRAL_BAD  — both versions wrong (flag irrelevant; defect elsewhere)
 *
 * Usage: DIRECT_URL=... node scripts/audit-price-discussed-counterfactual.js
 */

const { Client } = require('pg');

const DIRECT_URL = process.env.DIRECT_URL;
if (!DIRECT_URL) {
  console.error('DIRECT_URL env var is required.');
  process.exit(1);
}

// ── suggestStrategy() — verbatim port from
//    src/conversation-context/conversation-context.service.ts:637-709
function simulateSuggestStrategy(ctx) {
  const scores = { hybrid: 0.5, price: 0.3, qualify: 0.3, convert: 0.2, phone: 0.15 };
  if (ctx.engagementLevel === 'hot') {
    scores.convert = 0.85; scores.hybrid = 0.5; scores.price = 0.4; scores.qualify = 0.25;
  } else if (ctx.engagementLevel === 'cold') {
    scores.price = 0.6; scores.hybrid = 0.45; scores.convert = 0.15; scores.qualify = 0.3;
  }
  if (ctx.customerIntent === 'price_shopping' && !ctx.priceDiscussed) {
    scores.price = Math.max(scores.price, 0.8);
    scores.hybrid = Math.max(scores.hybrid, 0.55);
  }
  const missingCount = Array.isArray(ctx.missingFields) ? ctx.missingFields.length : 0;
  if (missingCount >= 2) {
    scores.qualify = Math.max(scores.qualify, 0.75); scores.hybrid = Math.max(scores.hybrid, 0.5);
  } else if (missingCount === 1) {
    scores.qualify = Math.max(scores.qualify, 0.5);
  }
  if (ctx.stage === 'quoting' || ctx.priceDiscussed) {
    scores.convert = Math.max(scores.convert, 0.7); scores.price = Math.min(scores.price, 0.35);
  }
  if (ctx.engagementLevel === 'hot' && ctx.totalMessages >= 6) {
    scores.phone = Math.max(scores.phone, 0.65);
  }
  if (missingCount >= 3) {
    scores.phone = Math.max(scores.phone, 0.55);
  }
  return Object.entries(scores).reduce(
    (best, [k, s]) => s > best.score ? { key: k, score: s } : best,
    { key: 'hybrid', score: 0 },
  ).key;
}

// ── Expected-goal keyword classifier (matches audit's prior agent)
function expectedGoal(msg) {
  const m = (msg || '').toLowerCase();
  if (/call me|callback|talk to (someone|a person)|live person|reach.*by phone|give.*\b(a |me a )?call\b|phone number/.test(m)) return 'phone';
  if (/how much|price|quote|estimate|cost|budget|how expensive|charge|\brate\b/.test(m)) return 'price';
  return 'qualify';
}

(async () => {
  const client = new Client({ connectionString: DIRECT_URL });
  await client.connect();
  try {
    // Hard-lock the session to read-only before any other statement.
    await client.query('SET default_transaction_read_only = on');
    await client.query('SET statement_timeout = 60000');

    // Universe: priceDiscussed=true rows in last 60d with a customer message.
    const universeRes = await client.query(`
      SELECT count(*)::int AS n
        FROM public.thread_contexts tc
        JOIN public.conversations c ON c.id = tc."conversationId"
       WHERE tc."priceDiscussed" = true
         AND c."lastMessageAt" > NOW() - INTERVAL '60 days'
         AND tc."customerMessages" > 0
    `);
    const universeSize = universeRes.rows[0].n;
    console.log(`Universe (priceDiscussed=true, last 60d, customerMessages>0): ${universeSize}`);

    const limit = Math.min(universeSize, 1500);
    const sql = `
      SELECT
        tc."conversationId",
        tc.stage,
        tc."customerIntent",
        tc."engagementLevel",
        tc."priceDiscussed",
        tc."missingFields",
        tc."totalMessages",
        c.platform,
        (SELECT m.content
           FROM public.messages m
          WHERE m."conversationId" = tc."conversationId"
            AND m.sender = 'customer'
            AND m.content IS NOT NULL
            AND length(trim(m.content)) > 0
          ORDER BY m."sentAt" DESC NULLS LAST
          LIMIT 1) AS latest_customer_msg
        FROM public.thread_contexts tc
        JOIN public.conversations c ON c.id = tc."conversationId"
       WHERE tc."priceDiscussed" = true
         AND c."lastMessageAt" > NOW() - INTERVAL '60 days'
         AND tc."customerMessages" > 0
       ORDER BY random()
       LIMIT $1
    `;
    const res = await client.query(sql, [limit]);
    console.log(`Scored sample: ${res.rows.length}\n`);

    let helped = 0, hurt = 0, neutralGood = 0, neutralBad = 0, skipped = 0;
    const transitions = new Map(); // "actual->counterfactual" -> { count, helps, hurts, neutralGood, neutralBad }
    const platformBreakdown = { thumbtack: { helped: 0, hurt: 0, neutralGood: 0, neutralBad: 0 }, yelp: { helped: 0, hurt: 0, neutralGood: 0, neutralBad: 0 } };

    const helpedExamples = [];
    const hurtExamples = [];

    for (const row of res.rows) {
      if (!row.latest_customer_msg) { skipped++; continue; }

      const baseCtx = {
        stage: row.stage,
        customerIntent: row.customerIntent,
        engagementLevel: row.engagementLevel,
        priceDiscussed: true,
        missingFields: Array.isArray(row.missingFields) ? row.missingFields : [],
        totalMessages: row.totalMessages,
      };
      const cfCtx = {
        ...baseCtx,
        priceDiscussed: false,
        stage: row.stage === 'quoting' ? 'qualification' : row.stage,
      };

      const actual = simulateSuggestStrategy(baseCtx);
      const counterfactual = simulateSuggestStrategy(cfCtx);
      const expected = expectedGoal(row.latest_customer_msg);

      const actualCorrect = actual === expected;
      const cfCorrect = counterfactual === expected;

      let bucket;
      if (actualCorrect && !cfCorrect) { helped++; bucket = 'HELPED'; }
      else if (!actualCorrect && cfCorrect) { hurt++; bucket = 'HURT'; }
      else if (actualCorrect && cfCorrect) { neutralGood++; bucket = 'NEUTRAL_GOOD'; }
      else { neutralBad++; bucket = 'NEUTRAL_BAD'; }

      if (platformBreakdown[row.platform]) {
        platformBreakdown[row.platform][
          bucket === 'HELPED' ? 'helped' :
          bucket === 'HURT' ? 'hurt' :
          bucket === 'NEUTRAL_GOOD' ? 'neutralGood' : 'neutralBad'
        ]++;
      }

      // Track only transitions where the flag actually changes the answer.
      if (actual !== counterfactual) {
        const key = `${actual} → ${counterfactual}`;
        if (!transitions.has(key)) transitions.set(key, { count: 0, helps: 0, hurts: 0, neutralGood: 0, neutralBad: 0 });
        const t = transitions.get(key);
        t.count++;
        if (bucket === 'HELPED') t.helps++;
        else if (bucket === 'HURT') t.hurts++;
        else if (bucket === 'NEUTRAL_GOOD') t.neutralGood++;
        else t.neutralBad++;
      }

      // Capture up to 4 examples per direction.
      if (bucket === 'HELPED' && helpedExamples.length < 4) {
        helpedExamples.push({
          id: row.conversationId, platform: row.platform,
          msg: row.latest_customer_msg.substring(0, 120),
          expected, actual, counterfactual,
        });
      }
      if (bucket === 'HURT' && hurtExamples.length < 4) {
        hurtExamples.push({
          id: row.conversationId, platform: row.platform,
          msg: row.latest_customer_msg.substring(0, 120),
          expected, actual, counterfactual,
        });
      }
    }

    const total = helped + hurt + neutralGood + neutralBad;
    console.log('─── Counterfactual table ───');
    console.log(`HELPED       : ${helped}  (${pct(helped, total)})`);
    console.log(`HURT         : ${hurt}  (${pct(hurt, total)})`);
    console.log(`NEUTRAL_GOOD : ${neutralGood}  (${pct(neutralGood, total)})`);
    console.log(`NEUTRAL_BAD  : ${neutralBad}  (${pct(neutralBad, total)})`);
    console.log(`Skipped (empty msg): ${skipped}`);
    console.log(`Sample N: ${total}`);
    console.log(`Net effect (HELPED - HURT) / N: ${pct(helped - hurt, total)}`);

    console.log('\n─── Where flag changes the answer (actual → counterfactual) ───');
    const sorted = [...transitions.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [k, t] of sorted) {
      console.log(`${k.padEnd(28)} count=${String(t.count).padStart(3)}  HELPED=${t.helps}  HURT=${t.hurts}  NEUTRAL_GOOD=${t.neutralGood}  NEUTRAL_BAD=${t.neutralBad}`);
    }

    console.log('\n─── Platform breakdown ───');
    for (const [plat, b] of Object.entries(platformBreakdown)) {
      const subtotal = b.helped + b.hurt + b.neutralGood + b.neutralBad;
      if (subtotal === 0) continue;
      console.log(`${plat.padEnd(10)} N=${subtotal}  HELPED=${b.helped}  HURT=${b.hurt}  NEUTRAL_GOOD=${b.neutralGood}  NEUTRAL_BAD=${b.neutralBad}`);
    }

    console.log('\n─── HURT examples ───');
    for (const ex of hurtExamples) {
      console.log(`  ${ex.platform.padEnd(9)} ${ex.id}`);
      console.log(`    msg: "${ex.msg.replace(/\s+/g, ' ')}"`);
      console.log(`    expected=${ex.expected}  actual=${ex.actual}  counterfactual=${ex.counterfactual}`);
    }

    console.log('\n─── HELPED examples ───');
    for (const ex of helpedExamples) {
      console.log(`  ${ex.platform.padEnd(9)} ${ex.id}`);
      console.log(`    msg: "${ex.msg.replace(/\s+/g, ' ')}"`);
      console.log(`    expected=${ex.expected}  actual=${ex.actual}  counterfactual=${ex.counterfactual}`);
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
