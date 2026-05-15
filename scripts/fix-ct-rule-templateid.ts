import 'dotenv/config';
process.env.DATABASE_URL = process.env.DIRECT_URL || process.env.DATABASE_URL;
import { PrismaClient } from '../generated/prisma';

const APPLY = process.argv.includes('--apply');

const RULE_IDS = [
  'b43609b7-7b9e-4b51-b145-d6b8e2815a13', // Spotless Homes Tampa | thumbtack
  '4f66a2be-1862-47fd-9c51-7a630aebe2e6', // Spotless Homes Tampa | yelp
  '51775fdf-9627-410e-ac0f-585fbf017832', // Spotless Homes Jacksonville | yelp
];

const p = new PrismaClient();

(async () => {
  console.log(APPLY ? '=== APPLY MODE ===' : '=== DRY RUN (pass --apply to write) ===');

  for (const id of RULE_IDS) {
    const before = await p.notificationRule.findUnique({
      where: { id },
      include: {
        messageTemplate: true,
        notificationSettings: {
          select: { savedAccount: { select: { businessName: true, platform: true } } },
        },
      },
    });
    if (!before) {
      console.log(`rule ${id}: NOT FOUND`);
      continue;
    }
    const acct = before.notificationSettings.savedAccount;
    console.log('—'.repeat(72));
    console.log(`account: ${acct.businessName} | ${acct.platform}`);
    console.log(`ruleId : ${before.id}`);
    console.log(`BEFORE  templateId=${before.templateId}`);
    console.log(`        linked: ${JSON.stringify((before.messageTemplate?.content || '').slice(0, 120))}`);
    console.log(`        inline: ${JSON.stringify((before.template || '').slice(0, 120))}`);
    console.log(`        → runtime currently sends: linked dump (BAD)`);
    console.log(`        → after fix: inline greeting (SAFE)`);

    if (APPLY) {
      // Sanity guards: only clear templateId if (a) sendToCustomer is true,
      // (b) inline rule.template is the safe greeting, (c) linked content
      // contains owner-dump markers. Refuse otherwise.
      const inlineSafe = /Hi \{\{lead\.name\}\}, this is \{\{account\.name\}\}/.test(before.template || '');
      const linkedDump = /New (Yelp )?lead:/.test(before.messageTemplate?.content || '');
      if (!before.sendToCustomer || !inlineSafe || !linkedDump) {
        console.log(`        SKIP — guard failed (sendToCustomer=${before.sendToCustomer} inlineSafe=${inlineSafe} linkedDump=${linkedDump})`);
        continue;
      }
      await p.notificationRule.update({
        where: { id: before.id },
        data: { templateId: null },
      });
      const after = await p.notificationRule.findUnique({ where: { id: before.id } });
      console.log(`AFTER   templateId=${after?.templateId}`);
      console.log(`        ✓ cleared`);
    }
  }

  await p.$disconnect();
})();
