/* eslint-disable */
/**
 * One-shot backfill — flip existing tenants' customer_deferred and
 * customer_hired_competitor sequence templates from template-mode to
 * AI-mode, matching the new seed default in
 * src/follow-up-engine/follow-up-seed.ts.
 *
 * Preserves user customisations: a row is only flipped when step[0]'s
 * messageTemplate is null OR matches the original hardcoded seed string
 * verbatim. Any other value means the user edited it — left alone.
 *
 * Usage:
 *   DATABASE_URL=$DIRECT_URL node scripts/_backfill-deferral-reengage-ai-default.js [--user=USER_ID] [--dry]
 *
 * --user=ID  Limit to one user. Default: every affected user.
 * --dry      Print what WOULD happen; don't write anything.
 */
const { PrismaClient } = require('../generated/prisma');
const p = new PrismaClient();

const args = process.argv.slice(2);
const onlyUser = (args.find((a) => a.startsWith('--user=')) || '').split('=')[1] || null;
const dry = args.includes('--dry');

// Verbatim copies of the strings that used to live inline in the seed.
// If step[0].messageTemplate matches one of these (or is null), the row
// is treated as untouched by the user and is safe to flip to AI mode.
const ORIGINAL_DEFERRAL =
  "Hi {{lead.name}}, just circling back — did you get a chance to think it over? Happy to answer any questions or help get you on the schedule if you're ready.";
const ORIGINAL_REENGAGE =
  "Hi {{lead.name}}, hope your cleaning went well! If anything didn't go the way you hoped, we'd be happy to help next time. No pressure either way.";

function originalFor(triggerState) {
  if (triggerState === 'customer_deferred') return ORIGINAL_DEFERRAL;
  if (triggerState === 'customer_hired_competitor') return ORIGINAL_REENGAGE;
  return null;
}

(async () => {
  const rows = await p.followUpSequenceTemplate.findMany({
    where: {
      triggerState: { in: ['customer_deferred', 'customer_hired_competitor'] },
      generationMode: 'template',
      ...(onlyUser ? { userId: onlyUser } : {}),
    },
    select: {
      id: true,
      userId: true,
      savedAccountId: true,
      platform: true,
      triggerState: true,
      stepsJson: true,
      name: true,
    },
  });
  console.log(`Found ${rows.length} row(s) currently in template mode`);

  let flipped = 0;
  let preservedUserEdits = 0;
  let malformed = 0;
  for (const row of rows) {
    const original = originalFor(row.triggerState);
    const steps = row.stepsJson && Array.isArray(row.stepsJson.steps) ? row.stepsJson.steps : null;
    if (!steps || steps.length === 0) {
      console.log(`  [skip-malformed] ${row.id} user=${row.userId} acct=${row.savedAccountId} — no steps[]`);
      malformed++;
      continue;
    }
    const step0 = steps[0];
    const current = step0?.messageTemplate ?? null;
    const isUntouched = current === null || current === '' || current === original;
    if (!isUntouched) {
      console.log(
        `  [preserve-user-edit] ${row.id} user=${row.userId} acct=${row.savedAccountId} trigger=${row.triggerState} — keeping custom message`,
      );
      preservedUserEdits++;
      continue;
    }

    const newSteps = steps.map((s, i) => {
      if (i !== 0) return s;
      const { messageTemplate: _drop, ...rest } = s;
      return rest;
    });
    const newStepsJson = { ...row.stepsJson, steps: newSteps };

    if (dry) {
      console.log(
        `  [DRY] ${row.id} user=${row.userId} acct=${row.savedAccountId} trigger=${row.triggerState} → generationMode=ai, clear messageTemplate`,
      );
    } else {
      await p.followUpSequenceTemplate.update({
        where: { id: row.id },
        data: { generationMode: 'ai', stepsJson: newStepsJson },
      });
      console.log(
        `  [flipped] ${row.id} user=${row.userId} acct=${row.savedAccountId} trigger=${row.triggerState}`,
      );
    }
    flipped++;
  }

  console.log(
    `\nDone. flipped=${flipped} preserved_user_edits=${preservedUserEdits} malformed=${malformed} dry=${dry}`,
  );
  await p.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
