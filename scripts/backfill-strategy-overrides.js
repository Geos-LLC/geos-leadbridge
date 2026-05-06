/**
 * One-time backfill: for any user with a global followUpStrategy set,
 * clear stale per-rule overrides on their AI AutomationRules so the global
 * strategy is honored.
 *
 * Why: the strategy-resolution chain in automation.service.ts has 3 legacy
 * override fields (replyMode='price', promptTemplateId, aiSystemPrompt) that
 * sit BEFORE STRATEGY_PROMPTS[followUpStrategy] in priority. Old rule rows
 * from the pre-unified-UI era (before commit a1510ca) carry stale values
 * that silently shadow the global setting.
 *
 * Safety:
 * - Only touches AI rules (useAi=true). Static template rules (useAi=false)
 *   are untouched — their templateId is the intentional config.
 * - Only touches users who have a global followUpStrategy set in
 *   followUpSettingsJson on at least one of their accounts.
 * - Read-first: prints the rules that would be cleared. Pass --execute
 *   to apply.
 */
const { PrismaClient } = require('../generated/prisma');

const EXECUTE = process.argv.includes('--execute');

(async () => {
  const p = new PrismaClient();
  try {
    // Find users with a global strategy on at least one account.
    const accounts = await p.savedAccount.findMany({
      where: { followUpSettingsJson: { contains: '"followUpStrategy"' } },
      select: { userId: true, followUpSettingsJson: true },
    });

    const userToStrategy = new Map();
    for (const a of accounts) {
      try {
        const s = JSON.parse(a.followUpSettingsJson);
        if (typeof s.followUpStrategy === 'string') {
          if (!userToStrategy.has(a.userId)) userToStrategy.set(a.userId, s.followUpStrategy);
        }
      } catch {}
    }

    console.log(`Found ${userToStrategy.size} user(s) with a global followUpStrategy set\n`);

    let totalCleared = 0;
    for (const [userId, strategy] of userToStrategy) {
      const candidates = await p.automationRule.findMany({
        where: {
          userId,
          useAi: true,
          OR: [
            { replyMode: 'price' },
            { promptTemplateId: { not: null } },
            { aiSystemPrompt: { not: null } },
          ],
        },
        select: {
          id: true, name: true, savedAccountId: true,
          replyMode: true, promptTemplateId: true,
          aiSystemPrompt: true,
        },
      });

      if (candidates.length === 0) continue;
      console.log(`-- user ${userId} (strategy=${strategy}) — ${candidates.length} rule(s) with overrides:`);
      for (const r of candidates) {
        console.log(`   ${r.id.slice(0, 8)} ${r.name} :: replyMode=${r.replyMode} promptTpl=${r.promptTemplateId ? r.promptTemplateId.slice(0,8) : 'null'} legacyAiPrompt=${r.aiSystemPrompt ? '(set)' : 'null'}`);
      }

      if (EXECUTE) {
        const result = await p.automationRule.updateMany({
          where: { id: { in: candidates.map(r => r.id) } },
          data: {
            replyMode: 'auto',
            promptTemplateId: null,
            aiSystemPrompt: null,
          },
        });
        console.log(`   → cleared ${result.count} rule(s)`);
        totalCleared += result.count;
      }
      console.log('');
    }

    if (EXECUTE) {
      console.log(`\nTotal cleared: ${totalCleared}`);
    } else {
      console.log('\n[DRY RUN] pass --execute to apply');
    }
  } finally {
    await p.$disconnect();
  }
})();
