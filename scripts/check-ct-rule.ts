import 'dotenv/config';
process.env.DATABASE_URL = process.env.DIRECT_URL || process.env.DATABASE_URL;
import { PrismaClient } from '../generated/prisma';
const p = new PrismaClient();

(async () => {
  // savedAccountId for Spotless Homes Tampa came from the call-connect log
  // businessId=163ae82a-e177-452e-b137-74cb738cb15b → that's the LB savedAccountId
  // But better: find all "Auto-Reply to Customer" rules to see the pattern.
  const rules = await p.notificationRule.findMany({
    where: { sendToCustomer: true, name: 'Auto-Reply to Customer' },
    include: {
      messageTemplate: true,
      notificationSettings: {
        select: {
          savedAccountId: true,
          template: true,
          savedAccount: { select: { businessName: true, platform: true } },
        },
      },
    },
    take: 30,
  });

  for (const r of rules) {
    const inlineHasDump = /New lead:|\{price\}|\{estimate\}|Location:[\s\S]*Service:/.test(r.template || '');
    const linkedHasDump = /New lead:|\{price\}|\{estimate\}|Location:[\s\S]*Service:/.test(r.messageTemplate?.content || '');
    console.log('—'.repeat(70));
    console.log('account :', r.notificationSettings.savedAccount.businessName, '|', r.notificationSettings.savedAccount.platform);
    console.log('saId    :', r.notificationSettings.savedAccountId);
    console.log('ruleId  :', r.id, 'enabled=', r.enabled, 'delayMin=', r.delayMinutes);
    console.log('templateId →', r.templateId || '(none)');
    console.log('inline  :', JSON.stringify((r.template || '').slice(0, 200)), inlineHasDump ? '⚠ DUMP' : '');
    if (r.messageTemplate) {
      console.log('linked  :', JSON.stringify((r.messageTemplate.content || '').slice(0, 200)), linkedHasDump ? '⚠ DUMP' : '');
    } else {
      console.log('linked  : (no MessageTemplate)');
    }
    console.log('settings.template (legacy fallback):', JSON.stringify((r.notificationSettings.template || '').slice(0, 200)));
  }

  await p.$disconnect();
})();
