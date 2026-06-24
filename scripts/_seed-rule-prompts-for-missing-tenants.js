/* eslint-disable */
/**
 * One-shot companion — for any tenant that has AI-mode rule sequences
 * pointing at unseeded prompts (the `no-prompt-seed` skips emitted by
 * _backfill-per-rule-prompt-template-ids.js), pre-seed the three
 * `type='prompt'` MessageTemplate rows and re-wire their sequence rows.
 *
 * Avoids waiting for those tenants to visit /templates to trigger the
 * lazy seed pass.
 *
 * Canonical prompt content is read live from a known-good donor user
 * (defaults to Spotless: c3d14499-…) so we never drift from the seed.
 *
 * Usage:
 *   DATABASE_URL=$DIRECT_URL node scripts/_seed-rule-prompts-for-missing-tenants.js [--donor=USER_ID] [--dry]
 */
const { PrismaClient } = require('../generated/prisma');
const p = new PrismaClient();

const args = process.argv.slice(2);
const donorId = (args.find((a) => a.startsWith('--donor=')) || '').split('=')[1] || 'c3d14499-dec1-42c3-a36c-713cb09842c6';
const dry = args.includes('--dry');

const PROMPT_NAME_FOR_TRIGGER = {
  customer_deferred:           'Customer Deferral',
  customer_hired_competitor:   'Re-engage',
  no_reply_after_conversion:   'Resume After Conversation',
};
const TRIGGER_STATES = Object.keys(PROMPT_NAME_FOR_TRIGGER);
const PROMPT_NAMES = [...new Set(Object.values(PROMPT_NAME_FOR_TRIGGER))];

(async () => {
  // 1. Pull canonical prompt content from donor.
  const donorPrompts = await p.messageTemplate.findMany({
    where: { userId: donorId, name: { in: PROMPT_NAMES }, type: 'prompt' },
    select: { name: true, content: true },
  });
  if (donorPrompts.length !== PROMPT_NAMES.length) {
    console.error(`Donor ${donorId} is missing canonical prompts. Found: ${donorPrompts.map(d => d.name).join(', ')}`);
    process.exit(1);
  }
  const canon = new Map(donorPrompts.map(d => [d.name, d.content]));
  console.log(`Loaded ${donorPrompts.length} canonical prompt(s) from donor ${donorId}`);

  // 2. Find users with AI-mode sequence rows that need wiring.
  const needyRows = await p.followUpSequenceTemplate.findMany({
    where: {
      triggerState: { in: TRIGGER_STATES },
      generationMode: 'ai',
      promptTemplateId: null,
    },
    select: { userId: true, triggerState: true },
  });
  const needyUsers = new Map(); // userId → Set<promptName>
  for (const row of needyRows) {
    const name = PROMPT_NAME_FOR_TRIGGER[row.triggerState];
    if (!needyUsers.has(row.userId)) needyUsers.set(row.userId, new Set());
    needyUsers.get(row.userId).add(name);
  }
  console.log(`Found ${needyUsers.size} user(s) with unwired AI-mode sequence rows`);

  // 3. For each user, seed only the prompt rows that don't already exist,
  //    then wire the sequence rows.
  let seededPrompts = 0;
  let wiredRows = 0;
  for (const [userId, neededNames] of needyUsers.entries()) {
    if (userId === donorId) continue; // donor already has them
    const existing = await p.messageTemplate.findMany({
      where: { userId, name: { in: [...neededNames] }, type: 'prompt' },
      select: { name: true, id: true },
    });
    const have = new Set(existing.map(e => e.name));
    const toSeed = [...neededNames].filter(n => !have.has(n));

    for (const name of toSeed) {
      if (dry) {
        console.log(`  [DRY-seed] user=${userId} prompt="${name}" (${(canon.get(name) || '').length} chars)`);
      } else {
        try {
          await p.messageTemplate.create({
            data: {
              userId,
              name,
              content: canon.get(name),
              type: 'prompt',
              isDefault: false,
            },
          });
          console.log(`  [seeded] user=${userId} prompt="${name}"`);
        } catch (err) {
          // P2002 = unique constraint race — already exists, treat as seeded.
          if (err?.code !== 'P2002') throw err;
          console.log(`  [seed-race] user=${userId} prompt="${name}" — already existed`);
        }
      }
      seededPrompts++;
    }

    // Re-query to get all prompt ids (newly-seeded + already-existing).
    const allUserPrompts = dry
      ? [...existing, ...toSeed.map(n => ({ name: n, id: 'DRY-NEW' }))]
      : await p.messageTemplate.findMany({
          where: { userId, name: { in: [...neededNames] }, type: 'prompt' },
          select: { name: true, id: true },
        });
    const promptIdByName = new Map(allUserPrompts.map(t => [t.name, t.id]));

    // Wire this user's sequence rows.
    for (const triggerState of TRIGGER_STATES) {
      const promptName = PROMPT_NAME_FOR_TRIGGER[triggerState];
      if (!neededNames.has(promptName)) continue;
      const promptId = promptIdByName.get(promptName);
      if (!promptId) continue;
      if (dry) {
        const candidates = await p.followUpSequenceTemplate.findMany({
          where: { userId, triggerState, generationMode: 'ai', promptTemplateId: null },
          select: { id: true },
        });
        console.log(`  [DRY-wire] user=${userId} trigger=${triggerState} → "${promptName}" rows=${candidates.length}`);
        wiredRows += candidates.length;
      } else {
        const result = await p.followUpSequenceTemplate.updateMany({
          where: { userId, triggerState, generationMode: 'ai', promptTemplateId: null },
          data: { promptTemplateId: promptId },
        });
        if (result.count > 0) {
          console.log(`  [wired] user=${userId} trigger=${triggerState} → "${promptName}" rows=${result.count}`);
          wiredRows += result.count;
        }
      }
    }
  }

  console.log(`\nDone. seeded_prompts=${seededPrompts} wired_rows=${wiredRows} dry=${dry}`);
  await p.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
