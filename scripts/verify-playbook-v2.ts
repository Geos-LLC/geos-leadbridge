/**
 * Playbook V2 verification script.
 *
 * Enforces the V2 "nothing disappears" contract by reporting on the three
 * pre-existing data stores + the new V2 storage + a runtime-prompt sample.
 *
 * Use BEFORE migration and AFTER migration to compare. Optionally snapshot
 * the BEFORE state and diff after.
 *
 * Usage:
 *   DATABASE_URL='<DIRECT_URL>' npx tsx scripts/verify-playbook-v2.ts
 *   DATABASE_URL='<DIRECT_URL>' npx tsx scripts/verify-playbook-v2.ts --snapshot before.json
 *   DATABASE_URL='<DIRECT_URL>' npx tsx scripts/verify-playbook-v2.ts --diff before.json
 *
 * What it checks:
 *   1. SavedAccount.faqJson — entry count per account (must not drop)
 *   2. SavedAccount.servicePricingJson — row count per account (must not drop)
 *   3. User.globalAiPrompt — character count per user (must not drop)
 *   4. SavedAccount.followUpSettingsJson.aiPlaybookV2 — section count per account
 *   5. Sample runtime prompt from one account — asserts BASE HARD RULES +
 *      AI PLAYBOOK + the existing GLOBAL/REFERENCE plumbing all appear.
 */

import { PrismaClient } from '../generated/prisma';
import * as fs from 'fs';
import { renderPlaybookBlock } from '../src/ai/playbook-renderer';

type Snapshot = {
  takenAt: string;
  users: { id: string; email: string; globalAiPromptChars: number }[];
  accounts: {
    id: string;
    businessName: string;
    faqEntries: number;
    pricingRows: number;
    playbookV2Sections: string[];
    stage3LegacyKeys: string[];
  }[];
};

const SNAPSHOT_FLAG = '--snapshot';
const DIFF_FLAG = '--diff';

function countFaqEntries(faqJson: string | null): number {
  if (!faqJson) return 0;
  try {
    const parsed = JSON.parse(faqJson) as unknown;
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.entries)) return (obj.entries as unknown[]).length;
      // Generic count of leaf string values
      return Object.values(obj).filter(v => typeof v === 'string' && v.trim().length > 0).length;
    }
    return 0;
  } catch { return 0; }
}

function countPricingRows(pricingJson: string | null): number {
  if (!pricingJson) return 0;
  try {
    const p = JSON.parse(pricingJson) as { priceTable?: unknown[] };
    return Array.isArray(p?.priceTable) ? p.priceTable.length : 0;
  } catch { return 0; }
}

function inspectFollowUpSettings(json: string | null): { v2Sections: string[]; legacyKeys: string[] } {
  if (!json) return { v2Sections: [], legacyKeys: [] };
  try {
    const s = JSON.parse(json) as Record<string, unknown>;
    const v2 = (s.aiPlaybookV2 ?? {}) as Record<string, unknown>;
    const legacy = (s.aiPlaybookInstructions ?? {}) as Record<string, unknown>;
    return {
      v2Sections: Object.keys(v2).filter(k => {
        const v = v2[k];
        return v && typeof v === 'object' && 'customInstructions' in (v as Record<string, unknown>)
          && typeof (v as Record<string, unknown>).customInstructions === 'string'
          && ((v as Record<string, unknown>).customInstructions as string).trim().length > 0;
      }),
      legacyKeys: Object.keys(legacy).filter(k => {
        const v = legacy[k];
        return typeof v === 'string' && v.trim().length > 0;
      }),
    };
  } catch { return { v2Sections: [], legacyKeys: [] }; }
}

async function takeSnapshot(prisma: PrismaClient): Promise<Snapshot> {
  const users = await prisma.user.findMany({ select: { id: true, email: true, globalAiPrompt: true } });
  const accounts = await prisma.savedAccount.findMany({
    select: { id: true, businessName: true, faqJson: true, servicePricingJson: true, followUpSettingsJson: true },
  });
  return {
    takenAt: new Date().toISOString(),
    users: users.map(u => ({
      id: u.id,
      email: u.email,
      globalAiPromptChars: (u.globalAiPrompt ?? '').length,
    })),
    accounts: accounts.map(a => {
      const { v2Sections, legacyKeys } = inspectFollowUpSettings(a.followUpSettingsJson);
      return {
        id: a.id,
        businessName: a.businessName ?? '',
        faqEntries: countFaqEntries(a.faqJson),
        pricingRows: countPricingRows(a.servicePricingJson),
        playbookV2Sections: v2Sections,
        stage3LegacyKeys: legacyKeys,
      };
    }),
  };
}

function printSnapshot(s: Snapshot, label: string) {
  console.log(`\n=== ${label} (${s.takenAt}) ===`);
  console.log(`Users: ${s.users.length}`);
  const usersWithPrompt = s.users.filter(u => u.globalAiPromptChars > 0);
  console.log(`  ${usersWithPrompt.length} with non-empty globalAiPrompt`);
  for (const u of usersWithPrompt.slice(0, 5)) {
    console.log(`    ${u.email.padEnd(35)} ${u.globalAiPromptChars} chars`);
  }
  console.log(`Accounts: ${s.accounts.length}`);
  const totalFaq = s.accounts.reduce((acc, a) => acc + a.faqEntries, 0);
  const totalPricing = s.accounts.reduce((acc, a) => acc + a.pricingRows, 0);
  const totalV2 = s.accounts.reduce((acc, a) => acc + a.playbookV2Sections.length, 0);
  const totalLegacy = s.accounts.reduce((acc, a) => acc + a.stage3LegacyKeys.length, 0);
  console.log(`  Total FAQ entries:           ${totalFaq}`);
  console.log(`  Total pricing rows:          ${totalPricing}`);
  console.log(`  Total Playbook V2 sections:  ${totalV2}`);
  console.log(`  Total Stage 3 legacy keys:   ${totalLegacy}`);

  for (const a of s.accounts.filter(a => a.faqEntries + a.pricingRows + a.playbookV2Sections.length + a.stage3LegacyKeys.length > 0).slice(0, 10)) {
    console.log(`  ${a.businessName.padEnd(35)} faq=${a.faqEntries} pricing=${a.pricingRows} v2=[${a.playbookV2Sections.join(',')}] legacy=[${a.stage3LegacyKeys.join(',')}]`);
  }
}

function diffSnapshots(before: Snapshot, after: Snapshot) {
  console.log('\n=== DIFF (after vs before) ===');
  const issues: string[] = [];

  // User globalAiPrompt
  for (const beforeUser of before.users) {
    const afterUser = after.users.find(u => u.id === beforeUser.id);
    if (!afterUser) { issues.push(`user ${beforeUser.email} disappeared`); continue; }
    if (afterUser.globalAiPromptChars < beforeUser.globalAiPromptChars) {
      issues.push(`user ${beforeUser.email}: globalAiPrompt shrank ${beforeUser.globalAiPromptChars} → ${afterUser.globalAiPromptChars} (DATA LOSS)`);
    }
  }

  // Account FAQ + pricing + V2
  for (const beforeAcc of before.accounts) {
    const afterAcc = after.accounts.find(a => a.id === beforeAcc.id);
    if (!afterAcc) { issues.push(`account ${beforeAcc.businessName} disappeared`); continue; }
    if (afterAcc.faqEntries !== beforeAcc.faqEntries) {
      issues.push(`account ${beforeAcc.businessName}: FAQ entries changed ${beforeAcc.faqEntries} → ${afterAcc.faqEntries}`);
    }
    if (afterAcc.pricingRows !== beforeAcc.pricingRows) {
      issues.push(`account ${beforeAcc.businessName}: pricing rows changed ${beforeAcc.pricingRows} → ${afterAcc.pricingRows}`);
    }
  }

  if (issues.length === 0) {
    console.log('  PASS — no data-loss issues detected.');
  } else {
    console.log('  ISSUES:');
    for (const i of issues) console.log(`    - ${i}`);
  }
}

async function sampleRuntimePrompt(prisma: PrismaClient) {
  console.log('\n=== Runtime prompt smoke test ===');
  const account = await prisma.savedAccount.findFirst({
    where: { followUpSettingsJson: { not: null } },
    select: { id: true, businessName: true, followUpSettingsJson: true },
  });
  if (!account) {
    console.log('  No SavedAccount with followUpSettingsJson to sample.');
    return;
  }
  const block = renderPlaybookBlock({ followUpSettingsJson: account.followUpSettingsJson });

  const checks: Array<[string, boolean]> = [
    ['BASE HARD RULES section header present', block.includes('=== BASE HARD RULES')],
    ['BASE HARD RULES SCHEDULING SAFETY rule present', block.includes('SCHEDULING SAFETY:')],
    ['BASE HARD RULES PRICING SAFETY rule present', block.includes('PRICING SAFETY:')],
    ['BASE HARD RULES OPT-OUT compliance present', block.includes('OPT-OUT COMPLIANCE:')],
    ['AI PLAYBOOK section header present', block.includes('=== AI PLAYBOOK ===')],
    ['BUSINESS INFORMATION section present', block.includes('[BUSINESS INFORMATION]')],
    ['PRICING GUIDANCE section present', block.includes('[PRICING GUIDANCE]')],
    ['QUALIFICATION GUIDANCE section present', block.includes('[QUALIFICATION GUIDANCE]')],
    ['BOOKING GUIDANCE section present', block.includes('[BOOKING GUIDANCE]')],
    ['OBJECTION HANDLING section present', block.includes('[OBJECTION HANDLING]')],
    ['HUMAN HANDOFF GUIDANCE section present', block.includes('[HUMAN HANDOFF GUIDANCE]')],
    ['FOLLOW-UP TONE section present', block.includes('[FOLLOW-UP TONE]')],
    ['AI PERSONALITY & BRAND VOICE section present', block.includes('[AI PERSONALITY & BRAND VOICE]')],
    ['No Stage 3 "Current behavior" wording (V2 contract guard)', !block.includes('Current behavior:')],
    ['No Stage 3 [BOOKING REQUESTS] header (renamed in V2)', !block.includes('[BOOKING REQUESTS]')],
  ];

  console.log(`  Sample account: ${account.businessName}`);
  console.log(`  Block size:     ${block.length} chars`);
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const snapshotIdx = args.indexOf(SNAPSHOT_FLAG);
  const diffIdx = args.indexOf(DIFF_FLAG);

  const prisma = new PrismaClient();
  const snapshot = await takeSnapshot(prisma);

  if (snapshotIdx >= 0 && args[snapshotIdx + 1]) {
    const path = args[snapshotIdx + 1];
    fs.writeFileSync(path, JSON.stringify(snapshot, null, 2));
    console.log(`Snapshot written to ${path}`);
    printSnapshot(snapshot, 'CURRENT');
    await prisma.$disconnect();
    return;
  }

  if (diffIdx >= 0 && args[diffIdx + 1]) {
    const path = args[diffIdx + 1];
    if (!fs.existsSync(path)) {
      console.error(`Snapshot file not found: ${path}`);
      process.exit(1);
    }
    const before = JSON.parse(fs.readFileSync(path, 'utf8')) as Snapshot;
    printSnapshot(before, 'BEFORE');
    printSnapshot(snapshot, 'AFTER');
    diffSnapshots(before, snapshot);
    await sampleRuntimePrompt(prisma);
    await prisma.$disconnect();
    return;
  }

  // No flags — just report current state + runtime check
  printSnapshot(snapshot, 'CURRENT');
  await sampleRuntimePrompt(prisma);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
