/* eslint-disable */
/**
 * One-shot backfill — wire FollowUpSequenceTemplate.promptTemplateId on
 * existing tenants' AI-mode rule sequences to the seeded `type='prompt'`
 * MessageTemplate of the matching name. Without this, AI mode falls back
 * to the shared OBJECTIVE_FLAVORS['follow_up'] flavor and the per-rule
 * prompts authored in commit f8a8c91b sit unused.
 *
 * Mapping:
 *   customer_deferred         → "Customer Deferral"
 *   customer_hired_competitor → "Re-engage"
 *   no_reply_after_conversion → "Resume After Conversation"
 *
 * Only touches rows where generationMode='ai' AND promptTemplateId is null,
 * so any tenant who already pointed a sequence at a custom prompt is left
 * alone.
 *
 * Usage:
 *   DATABASE_URL=$DIRECT_URL node scripts/_backfill-per-rule-prompt-template-ids.js [--user=USER_ID] [--dry]
 *
 * --user=ID  Limit to one user. Default: every affected user.
 * --dry      Print what WOULD happen; don't write anything.
 */
const { PrismaClient } = require('../generated/prisma');
const p = new PrismaClient();

const args = process.argv.slice(2);
const onlyUser = (args.find((a) => a.startsWith('--user=')) || '').split('=')[1] || null;
const dry = args.includes('--dry');

const PROMPT_NAME_FOR_TRIGGER = {
  customer_deferred:           'Customer Deferral',
  customer_hired_competitor:   'Re-engage',
  no_reply_after_conversion:   'Resume After Conversation',
};
const TRIGGER_STATES = Object.keys(PROMPT_NAME_FOR_TRIGGER);

(async () => {
  const rows = await p.followUpSequenceTemplate.findMany({
    where: {
      triggerState: { in: TRIGGER_STATES },
      generationMode: 'ai',
      promptTemplateId: null,
      ...(onlyUser ? { userId: onlyUser } : {}),
    },
    select: {
      id: true,
      userId: true,
      savedAccountId: true,
      triggerState: true,
      name: true,
    },
  });
  console.log(`Found ${rows.length} AI-mode row(s) with null promptTemplateId`);

  // Pre-resolve prompt ids per (userId, name) to avoid N queries per row.
  const cache = new Map();
  const promptIdFor = async (userId, name) => {
    const key = `${userId}::${name}`;
    if (cache.has(key)) return cache.get(key);
    const tmpl = await p.messageTemplate.findFirst({
      where: { userId, name, type: 'prompt' },
      select: { id: true },
    });
    const id = tmpl?.id ?? null;
    cache.set(key, id);
    return id;
  };

  let wired = 0;
  let missingPrompt = 0;
  for (const row of rows) {
    const promptName = PROMPT_NAME_FOR_TRIGGER[row.triggerState];
    const promptId = await promptIdFor(row.userId, promptName);
    if (!promptId) {
      console.log(
        `  [no-prompt-seed] ${row.id} user=${row.userId} trigger=${row.triggerState} — ` +
        `tenant has no "${promptName}" type=prompt row; will pick up on next /templates visit`,
      );
      missingPrompt++;
      continue;
    }
    if (dry) {
      console.log(
        `  [DRY] ${row.id} user=${row.userId} acct=${row.savedAccountId} trigger=${row.triggerState} → promptTemplateId=${promptId} ("${promptName}")`,
      );
    } else {
      await p.followUpSequenceTemplate.update({
        where: { id: row.id },
        data: { promptTemplateId: promptId },
      });
      console.log(
        `  [wired] ${row.id} user=${row.userId} acct=${row.savedAccountId} trigger=${row.triggerState} → "${promptName}"`,
      );
    }
    wired++;
  }

  console.log(
    `\nDone. wired=${wired} missing_prompt=${missingPrompt} dry=${dry}`,
  );
  await p.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
