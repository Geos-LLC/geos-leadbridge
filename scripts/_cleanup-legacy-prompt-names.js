/* eslint-disable */
/**
 * One-shot — tenant-wide drop of the 6 legacy AI-prompt names that
 * predate the 2026-06-23 templates restructure. Mirror of
 * _cleanup-legacy-template-names.js, scoped to type='prompt'.
 *
 * Targets:
 *   First Reply                              → repoint to Instant Reply, then delete
 *   AI Prompt First Reply with Square Footage → delete (no canonical)
 *   Price-Anchor Strategy                    → delete (runtime strategy lives in code)
 *   Conversion Strategy                      → delete (same)
 *   Qualification Strategy                   → delete (same)
 *   Hybrid Strategy                          → delete (same)
 *
 * Runtime strategy prompts come from `src/ai/strategy-prompts.ts` (the
 * STRATEGY_PROMPTS const), NOT MessageTemplate rows — these editable
 * copies are vestigial seeds from before that centralisation and only
 * confuse the Templates page.
 *
 * Usage:
 *   DATABASE_URL=$DIRECT_URL node scripts/_cleanup-legacy-prompt-names.js [--dry]
 */
const { PrismaClient } = require('../generated/prisma');
const p = new PrismaClient();

const dry = process.argv.includes('--dry');

const LEGACY_NAMES = {
  'First Reply':                               { type: 'prompt', repointTo: 'Instant Reply' },
  'AI Prompt First Reply with Square Footage': { type: 'prompt', repointTo: null },
  'Price-Anchor Strategy':                     { type: 'prompt', repointTo: null },
  'Conversion Strategy':                       { type: 'prompt', repointTo: null },
  'Qualification Strategy':                    { type: 'prompt', repointTo: null },
  'Hybrid Strategy':                           { type: 'prompt', repointTo: null },
};

async function repointRules(legacyId, canonicalId) {
  // For prompt-type templates the FK on AutomationRule is promptTemplateId.
  // Repoint both message-side templateId (defensive — shouldn't match for
  // a prompt) and prompt-side promptTemplateId.
  const ar = await p.automationRule.updateMany({
    where: { templateId: legacyId },
    data:  { templateId: canonicalId },
  });
  const arp = await p.automationRule.updateMany({
    where: { promptTemplateId: legacyId },
    data:  { promptTemplateId: canonicalId },
  });
  const nr = await p.notificationRule.updateMany({
    where: { templateId: legacyId },
    data:  { templateId: canonicalId },
  });
  return { automationRulesMsg: ar.count, automationRulesPrompt: arp.count, notificationRules: nr.count };
}

async function countRefs(legacyId) {
  const [arMsg, arPrompt, nr] = await Promise.all([
    p.automationRule.count({ where: { templateId: legacyId } }),
    p.automationRule.count({ where: { promptTemplateId: legacyId } }),
    p.notificationRule.count({ where: { templateId: legacyId } }),
  ]);
  return { arMsg, arPrompt, nr, total: arMsg + arPrompt + nr };
}

(async () => {
  const summary = { tenants: 0, deleted: 0, repointed: 0, set_null_refs: 0 };

  for (const [legacyName, cfg] of Object.entries(LEGACY_NAMES)) {
    const legacyRows = await p.messageTemplate.findMany({
      where: { name: legacyName, type: cfg.type },
      select: { id: true, userId: true },
    });
    console.log(`\n== ${legacyName} (${legacyRows.length} tenant${legacyRows.length === 1 ? '' : 's'}) ==`);
    if (legacyRows.length === 0) continue;
    summary.tenants += legacyRows.length;

    for (const row of legacyRows) {
      let canonicalId = null;
      if (cfg.repointTo) {
        const canonical = await p.messageTemplate.findFirst({
          where: { userId: row.userId, name: cfg.repointTo, type: cfg.type },
          select: { id: true },
        });
        canonicalId = canonical?.id ?? null;
        if (!canonicalId) {
          console.log(`  user=${row.userId} no canonical "${cfg.repointTo}" exists → FKs will null on delete`);
        }
      }

      const refs = await countRefs(row.id);

      if (dry) {
        const action = canonicalId
          ? `would repoint refs (ar=${refs.arMsg}+${refs.arPrompt}, nr=${refs.nr}) → "${cfg.repointTo}" then delete`
          : refs.total > 0
            ? `would delete (refs=${refs.total} will SET NULL — rule falls back to inline / AI default)`
            : `would delete (no refs)`;
        console.log(`  [DRY] user=${row.userId} ${action}`);
        summary.deleted++;
        if (canonicalId) summary.repointed++;
        else if (refs.total > 0) summary.set_null_refs += refs.total;
        continue;
      }

      if (canonicalId) {
        const moved = await repointRules(row.id, canonicalId);
        console.log(`  user=${row.userId} repointed ar=${moved.automationRulesMsg}+${moved.automationRulesPrompt} nr=${moved.notificationRules} → "${cfg.repointTo}"`);
        summary.repointed++;
      } else if (refs.total > 0) {
        console.log(`  user=${row.userId} no canonical — deleting; ${refs.total} ref(s) will SET NULL`);
        summary.set_null_refs += refs.total;
      }

      await p.messageTemplate.delete({ where: { id: row.id } });
      summary.deleted++;
    }
  }

  console.log(`\nDone. ${JSON.stringify(summary)} dry=${dry}`);
  await p.$disconnect();
})().catch(e => {
  console.error(e);
  process.exit(1);
});
