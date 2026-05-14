// Backfill SavedAccount.followUpActiveHoursStart/End rows that got saved
// inverted (e.g. start=18:00, end=09:00) because of the inverted defaults that
// used to live in Services.tsx (useState('18:00') / useState('09:00')). With
// followUpAvailability='active_hours' the scheduler reads that as "active
// overnight, blocked during the day" and snaps every daytime follow-up to the
// start of the overnight window — typically 6pm local. End user impression:
// follow-ups never fire on the same business day.
//
// What "inverted" means here: start > end on a 24h wall clock. A legitimate
// overnight window (e.g. a 24/7 service that takes a break 02:00-06:00) would
// look the same shape, but those don't exist on this product — the active
// hours UI is meant for daytime business hours only. We still leave a manual
// override list (KEEP_OVERNIGHT_ACCOUNT_IDS) in case any future legitimate
// overnight account shows up; populate it before EXECUTE=1 if needed.
//
// Also reschedules FollowUpEnrollment rows whose nextStepDueAt was bumped by
// the bad window — anything currently in the future on an affected account
// gets pulled back to "now + 5 min" so the next cron tick sends it. The
// scheduler will re-snap based on the corrected window, so this is safe.
//
// DRY RUN by default. Set EXECUTE=1 to apply.
//
// Usage:
//   DATABASE_URL=$DIRECT_URL node scripts/backfill-fix-inverted-active-hours.js
//   DATABASE_URL=$DIRECT_URL EXECUTE=1 node scripts/backfill-fix-inverted-active-hours.js

const { PrismaClient } = require('../generated/prisma');

const KEEP_OVERNIGHT_ACCOUNT_IDS = new Set([
  // Add SavedAccount.id values here for accounts that legitimately want an
  // overnight active-hours window. Anything listed is skipped by the swap.
]);

function toMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function isInverted(start, end) {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === null || e === null) return false;
  return s > e;
}

(async () => {
  const p = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const execute = process.env.EXECUTE === '1';

  try {
    // followUpAvailability lives inside followUpSettingsJson, not its own
    // column. We pull every account with non-null active-hours times and
    // filter in JS so we can also read the JSON blob in the same pass.
    const accounts = await p.savedAccount.findMany({
      where: {
        followUpActiveHoursStart: { not: null },
        followUpActiveHoursEnd: { not: null },
      },
      select: {
        id: true,
        userId: true,
        businessName: true,
        platform: true,
        followUpActiveHoursStart: true,
        followUpActiveHoursEnd: true,
        followUpSettingsJson: true,
      },
    });

    const candidates = [];
    let inActiveHoursMode = 0;
    let alreadyDaytime = 0;
    let kepOvernight = 0;

    for (const a of accounts) {
      let settings = {};
      try { settings = JSON.parse(a.followUpSettingsJson || '{}'); } catch {}
      const mode = settings.followUpAvailability ?? settings.availability;
      if (mode !== 'active_hours') continue;
      inActiveHoursMode++;

      if (!isInverted(a.followUpActiveHoursStart, a.followUpActiveHoursEnd)) {
        alreadyDaytime++;
        continue;
      }
      if (KEEP_OVERNIGHT_ACCOUNT_IDS.has(a.id)) {
        kepOvernight++;
        continue;
      }

      candidates.push({
        id: a.id,
        userId: a.userId,
        businessName: a.businessName,
        platform: a.platform,
        from: `${a.followUpActiveHoursStart} → ${a.followUpActiveHoursEnd}`,
        to: `${a.followUpActiveHoursEnd} → ${a.followUpActiveHoursStart}`,
        newStart: a.followUpActiveHoursEnd,
        newEnd: a.followUpActiveHoursStart,
      });
    }

    console.log(`\nScanned ${accounts.length} SavedAccount rows with active-hours times set.`);
    console.log(`  active_hours mode enabled: ${inActiveHoursMode}`);
    console.log(`  already-daytime windows:   ${alreadyDaytime}`);
    console.log(`  inverted (will swap):      ${candidates.length}`);
    console.log(`  kept-overnight allowlist:  ${kepOvernight}\n`);

    if (candidates.length === 0) {
      console.log('No accounts need fixing. Exiting.');
      await p.$disconnect();
      return;
    }

    for (const c of candidates) {
      console.log(`  - ${c.platform} ${c.businessName} (id=${c.id}, user=${c.userId})`);
      console.log(`      ${c.from}   →   ${c.to}`);
    }

    if (!execute) {
      console.log('\nDRY RUN — re-run with EXECUTE=1 to apply.\n');
      await p.$disconnect();
      return;
    }

    // 1) Swap the active-hours window on the affected SavedAccount rows.
    let swapped = 0;
    for (const c of candidates) {
      await p.savedAccount.update({
        where: { id: c.id },
        data: {
          followUpActiveHoursStart: c.newStart,
          followUpActiveHoursEnd: c.newEnd,
        },
      });
      swapped++;
    }

    // 2) Pull forward any future-dated follow-up enrollments on those accounts.
    // The scheduler will re-snap if the (now corrected) window still excludes
    // the time, so this is conservative and safe.
    const affectedUserIds = Array.from(new Set(candidates.map(c => c.userId)));
    const candidateAccountIds = candidates.map(c => c.id);
    const nowPlus5 = new Date(Date.now() + 5 * 60_000);

    const futureEnrollments = await p.followUpEnrollment.findMany({
      where: {
        status: 'active',
        nextStepDueAt: { gt: new Date() },
        lead: {
          userId: { in: affectedUserIds },
          businessId: { not: null },
        },
      },
      select: {
        id: true,
        nextStepDueAt: true,
        lead: { select: { businessId: true, userId: true } },
      },
    });

    // Cross-reference each enrollment's lead.businessId/userId to a SavedAccount id.
    const accountsForUsers = await p.savedAccount.findMany({
      where: { userId: { in: affectedUserIds }, id: { in: candidateAccountIds } },
      select: { id: true, userId: true, businessId: true },
    });
    const acctKey = (userId, businessId) => `${userId}::${businessId}`;
    const affectedAcctKeys = new Set(
      accountsForUsers.map(a => acctKey(a.userId, a.businessId)),
    );

    let pulledForward = 0;
    for (const e of futureEnrollments) {
      const key = acctKey(e.lead.userId, e.lead.businessId);
      if (!affectedAcctKeys.has(key)) continue;
      await p.followUpEnrollment.update({
        where: { id: e.id },
        data: { nextStepDueAt: nowPlus5 },
      });
      pulledForward++;
    }

    console.log(`\nEXECUTE complete.`);
    console.log(`  active-hours windows swapped: ${swapped}`);
    console.log(`  enrollments pulled forward:   ${pulledForward}\n`);
  } finally {
    await p.$disconnect();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
