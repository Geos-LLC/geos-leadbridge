/**
 * Migrate Stage 3 Playbook custom instructions into V2 storage.
 *
 *   Source: SavedAccount.followUpSettingsJson.aiPlaybookInstructions
 *           (Stage 3 shape: { [oldKey]: string })
 *
 *   Target: SavedAccount.followUpSettingsJson.aiPlaybookV2
 *           (V2 shape: { [newKey]: { customInstructions: string } })
 *
 * Mapping:
 *   general_behavior          -> personality_brand_voice
 *   booking_requests          -> booking_guidance
 *   human_contact             -> human_handoff_guidance
 *   pricing                   -> pricing_guidance
 *   key_details               -> qualification_guidance
 *   customer_defers           -> followup_tone
 *   hired_another             -> objection_handling
 *   opt_out                   -> APPENDED to User.globalAiPrompt with a note
 *                                 (no V2 HOW section is the right home)
 *
 * "Nothing disappears" rule:
 *   - All non-empty text is preserved either in aiPlaybookV2 or appended to
 *     User.globalAiPrompt with a clear migration marker the user can review.
 *   - The Stage 3 aiPlaybookInstructions key is LEFT IN PLACE for one
 *     release as rollback safety. A follow-up migration drops it.
 *
 * Usage:
 *   DATABASE_URL='<DIRECT_URL>' npx tsx scripts/migrate-playbook-v2.ts --dry-run
 *   DATABASE_URL='<DIRECT_URL>' npx tsx scripts/migrate-playbook-v2.ts
 *
 * --dry-run prints planned changes per account without writing.
 * Re-running is safe: idempotent — never overwrites an existing aiPlaybookV2
 * entry for a section.
 */

import { PrismaClient } from '../generated/prisma';

const DRY_RUN = process.argv.includes('--dry-run');

const STAGE3_TO_V2_MAP: Record<string, string | null> = {
  general_behavior:    'personality_brand_voice',
  booking_requests:    'booking_guidance',
  human_contact:       'human_handoff_guidance',
  pricing:             'pricing_guidance',
  key_details:         'qualification_guidance',
  customer_defers:     'followup_tone',
  hired_another:       'objection_handling',
  opt_out:             null, // → User.globalAiPrompt append
};

const STAGE3_SECTION_DISPLAY: Record<string, string> = {
  general_behavior: 'General AI Behavior',
  booking_requests: 'Booking Requests',
  human_contact:    'Human Contact Requests',
  pricing:          'Pricing',
  key_details:      'Key Details Collected',
  customer_defers:  'Customer Defers',
  hired_another:    'Hired Another Company',
  opt_out:          'Opt-Out',
};

type Stage3Instructions = Record<string, string>;
type V2Storage = Record<string, { customInstructions: string }>;

type AccountPlan = {
  savedAccountId: string;
  userId: string;
  accountName: string;
  v2Updates: V2Storage;       // new aiPlaybookV2 keys to write
  globalPromptAppend: string;  // text to append to User.globalAiPrompt
  unchanged: string[];         // reasons for skipping (e.g. v2 already present)
};

function planAccount(
  savedAccountId: string,
  userId: string,
  accountName: string,
  followUpSettings: Record<string, unknown>,
): AccountPlan {
  const stage3 = (followUpSettings.aiPlaybookInstructions ?? {}) as Stage3Instructions;
  const existingV2 = (followUpSettings.aiPlaybookV2 ?? {}) as V2Storage;
  const plan: AccountPlan = {
    savedAccountId, userId, accountName,
    v2Updates: {}, globalPromptAppend: '', unchanged: [],
  };

  for (const [oldKey, text] of Object.entries(stage3)) {
    if (typeof text !== 'string' || text.trim().length === 0) continue;

    const newKey = STAGE3_TO_V2_MAP[oldKey];
    if (newKey === undefined) {
      // Unknown old key — orphan; route to globalAiPrompt with a note
      plan.globalPromptAppend +=
        `\n\n[Migrated from Stage 3: ${oldKey} (${accountName})]\n${text.trim()}`;
      continue;
    }

    if (newKey === null) {
      // Explicit no-V2-home — append to globalAiPrompt
      plan.globalPromptAppend +=
        `\n\n[Migrated from Stage 3: ${STAGE3_SECTION_DISPLAY[oldKey] || oldKey} (${accountName})]\n${text.trim()}`;
      continue;
    }

    // Standard map: write to V2 keyed by newKey, BUT only if V2 doesn't already have it
    if (existingV2[newKey] && typeof existingV2[newKey].customInstructions === 'string'
        && existingV2[newKey].customInstructions.trim().length > 0) {
      plan.unchanged.push(`${newKey}: V2 already populated, leaving Stage 3 text un-migrated to avoid overwrite`);
      continue;
    }
    plan.v2Updates[newKey] = {
      customInstructions: `[Migrated from Stage 3: ${STAGE3_SECTION_DISPLAY[oldKey] || oldKey}]\n${text.trim()}`,
    };
  }

  return plan;
}

async function main() {
  const prisma = new PrismaClient();
  const banner = DRY_RUN ? '=== DRY RUN — no writes ===' : '=== LIVE MIGRATION ===';
  console.log(banner);

  // Pull every saved account with a non-empty followUpSettingsJson
  const accounts = await prisma.savedAccount.findMany({
    where: { followUpSettingsJson: { not: null } },
    select: {
      id: true, userId: true, businessName: true, followUpSettingsJson: true,
    },
  });

  console.log(`Accounts with followUpSettingsJson: ${accounts.length}`);

  const plans: AccountPlan[] = [];
  for (const acc of accounts) {
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(acc.followUpSettingsJson ?? '{}') as Record<string, unknown>;
    } catch {
      console.warn(`  SKIP  ${acc.id} (${acc.businessName ?? '(no name)'}): invalid JSON`);
      continue;
    }
    const plan = planAccount(acc.id, acc.userId, acc.businessName ?? acc.id, settings);
    const hasAction = Object.keys(plan.v2Updates).length > 0 || plan.globalPromptAppend.length > 0 || plan.unchanged.length > 0;
    if (hasAction) plans.push(plan);
  }

  console.log(`\nAccounts with Stage 3 customizations to migrate: ${plans.length}`);

  // ─── Plan output ───────────────────────────────────────────────────────
  for (const p of plans) {
    console.log(`\n--- ${p.accountName} (${p.savedAccountId}) ---`);
    const v2Keys = Object.keys(p.v2Updates);
    if (v2Keys.length > 0) {
      console.log(`  WRITE aiPlaybookV2 keys: ${v2Keys.join(', ')}`);
      for (const k of v2Keys) {
        const preview = p.v2Updates[k].customInstructions.slice(0, 80).replace(/\n/g, ' ↵ ');
        console.log(`    [${k}] "${preview}${p.v2Updates[k].customInstructions.length > 80 ? '…' : ''}"`);
      }
    }
    if (p.globalPromptAppend) {
      console.log(`  APPEND to User.globalAiPrompt (userId=${p.userId}): ${p.globalPromptAppend.length} chars`);
    }
    if (p.unchanged.length > 0) {
      for (const note of p.unchanged) console.log(`  SKIP  ${note}`);
    }
  }

  if (DRY_RUN) {
    console.log('\n=== DRY RUN — no changes written. Re-run without --dry-run to apply. ===');
    await prisma.$disconnect();
    return;
  }

  // ─── Live writes ───────────────────────────────────────────────────────
  console.log('\n=== Applying changes ===');

  // Group globalPromptAppend by userId so each user's globalAiPrompt is
  // updated once per migration run (across all their accounts).
  const globalAppendByUser = new Map<string, string>();
  for (const p of plans) {
    if (!p.globalPromptAppend) continue;
    globalAppendByUser.set(p.userId, (globalAppendByUser.get(p.userId) ?? '') + p.globalPromptAppend);
  }

  // 1) Update SavedAccount.followUpSettingsJson with new aiPlaybookV2 keys
  for (const p of plans) {
    if (Object.keys(p.v2Updates).length === 0) continue;

    const current = await prisma.savedAccount.findUnique({
      where: { id: p.savedAccountId },
      select: { followUpSettingsJson: true },
    });
    const settings = current?.followUpSettingsJson
      ? (JSON.parse(current.followUpSettingsJson) as Record<string, unknown>)
      : {};
    const existingV2 = (settings.aiPlaybookV2 ?? {}) as V2Storage;
    const merged: V2Storage = { ...existingV2 };
    for (const [k, v] of Object.entries(p.v2Updates)) {
      if (!merged[k] || !merged[k].customInstructions || merged[k].customInstructions.trim().length === 0) {
        merged[k] = v;
      }
    }
    const updated = { ...settings, aiPlaybookV2: merged };
    await prisma.savedAccount.update({
      where: { id: p.savedAccountId },
      data:  { followUpSettingsJson: JSON.stringify(updated) },
    });
    console.log(`  WROTE  account=${p.savedAccountId} keys=[${Object.keys(p.v2Updates).join(',')}]`);
  }

  // 2) Append to User.globalAiPrompt
  for (const [userId, appendText] of globalAppendByUser.entries()) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { globalAiPrompt: true },
    });
    const existing = user?.globalAiPrompt ?? '';
    const next = (existing.trim().length > 0 ? existing : '') + appendText;
    await prisma.user.update({
      where: { id: userId },
      data:  { globalAiPrompt: next },
    });
    console.log(`  APPENDED user=${userId} +${appendText.length} chars`);
  }

  console.log('\n=== Migration complete ===');
  console.log('Stage 3 aiPlaybookInstructions key left in place for one release (rollback safety).');
  console.log('Verify with: npx tsx scripts/verify-playbook-v2.ts');

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
