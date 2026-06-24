/* eslint-disable */
/**
 * One-shot — delete the 5 legacy MessageTemplate names that the 2026-06-23
 * seed restructure dropped. Tenant-wide. Re-points any AutomationRule /
 * NotificationRule that referenced the legacy template to the canonical
 * replacement when one exists (otherwise the FK already cascades to NULL
 * via onDelete: SetNull, leaving the rule on its inline template).
 *
 * Targets:
 *   Auto Reply - New Lead       → repoint to Instant Reply, then delete
 *   Auto Reply - Follow Up      → repoint to Follow Up,     then delete
 *   Auto Reply - Welcome        → delete (FK → NULL)
 *   CT - Auto Reply             → delete (FK → NULL)
 *   Alert - New Lead Notification → delete (FK → NULL)
 *
 * Usage:
 *   DATABASE_URL=$DIRECT_URL node scripts/_cleanup-legacy-template-names.js [--dry]
 */
const { PrismaClient } = require('../generated/prisma');
const p = new PrismaClient();

const dry = process.argv.includes('--dry');

// legacy name → optional canonical replacement (null = delete + NULL FKs)
const LEGACY_NAMES = {
  'Auto Reply - New Lead':       { type: 'message', repointTo: 'Instant Reply' },
  'Auto Reply - Follow Up':      { type: 'message', repointTo: 'Follow Up' },
  'Auto Reply - Welcome':        { type: 'message', repointTo: null },
  'CT - Auto Reply':             { type: 'message', repointTo: null },
  'Alert - New Lead Notification': { type: 'message', repointTo: null },
};

async function repointRules(legacyId, canonicalId) {
  // templateId is globally unique on each rule table — no need to scope
  // by userId. NotificationRule has no direct userId field anyway (it's
  // scoped via notificationSettingsId → NotificationSettings → User).
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
  const summary = { tenants: 0, deleted: 0, repointed: 0, skipped_no_canonical_but_referenced: 0 };

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
          console.log(`  user=${row.userId} no canonical "${cfg.repointTo}" exists → skipping repoint; FKs will null on delete`);
        }
      }

      const refs = await countRefs(row.id);

      if (dry) {
        const action = canonicalId
          ? `would repoint refs (ar=${refs.arMsg}+${refs.arPrompt}, nr=${refs.nr}) → "${cfg.repointTo}" then delete`
          : refs.total > 0
            ? `would delete (refs=${refs.total} will SET NULL — rule falls back to inline template)`
            : `would delete (no refs)`;
        console.log(`  [DRY] user=${row.userId} ${action}`);
        summary.deleted++;
        if (canonicalId) summary.repointed++;
        else if (refs.total > 0) summary.skipped_no_canonical_but_referenced++;
        continue;
      }

      if (canonicalId) {
        const moved = await repointRules(row.id, canonicalId);
        console.log(`  user=${row.userId} repointed ar=${moved.automationRulesMsg}+${moved.automationRulesPrompt} nr=${moved.notificationRules} → "${cfg.repointTo}"`);
        summary.repointed++;
      } else if (refs.total > 0) {
        console.log(`  user=${row.userId} no canonical — deleting; ${refs.total} ref(s) will SET NULL`);
        summary.skipped_no_canonical_but_referenced++;
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
