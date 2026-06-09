/**
 * Backfill — restore the real customer phone on Thumbtack leads from the
 * original LEADS_V4 webhook payload, and move the substitute number that the
 * GET /negotiations/{id} endpoint had overwritten into customerPhoneSubstitute.
 *
 * Background — per TT engineering (2026-04), the LEADS_V4 webhook payload
 * delivers the REAL customer phone. The GET negotiation endpoint still returns
 * a substitute/forwarding number. Until this PR every sync (importLead,
 * refetchLeadFromPlatform, etc.) clobbered the webhook's real number with the
 * substitute. This script reads the surviving webhook payloads from the
 * WebhookEvent table and restores the real number on existing Lead rows.
 *
 * For each Thumbtack lead:
 *   - Look up the latest NegotiationCreatedV4 webhook event by negotiationID
 *   - Parse payload.data.customer.phone (the real number)
 *   - If it matches Lead.customerPhone: no-op (nothing was clobbered)
 *   - If it differs and Lead.customerPhone is non-null: that current value is
 *     the substitute. Move current -> customerPhoneSubstitute (only if the
 *     substitute slot is empty), set customerPhone = webhook real
 *   - If webhook real is null: skip (no real number to restore)
 *
 * Idempotent — re-running flips no rows once leads are aligned.
 *
 * Modes:
 *   DRY_RUN=true   — report what would change, no writes (default)
 *   DRY_RUN=false  — execute the writes
 *
 * Usage:
 *   DATABASE_URL=$DIRECT_URL DRY_RUN=true  npx ts-node scripts/backfill-thumbtack-real-phone.ts
 *   DATABASE_URL=$DIRECT_URL DRY_RUN=false npx ts-node scripts/backfill-thumbtack-real-phone.ts
 *
 * Exit codes:
 *   0 — finished cleanly
 *   1 — fatal error
 */

import { PrismaClient } from '../generated/prisma';

const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';

async function main() {
  const prisma = new PrismaClient();
  console.log(`[backfill-thumbtack-real-phone] mode=${DRY_RUN ? 'DRY_RUN' : 'APPLY'}`);

  try {
    // Pull the latest NegotiationCreatedV4 webhook event per negotiationID.
    // Sort desc by receivedAt and dedupe in-process — webhook retries can
    // produce multiple rows for the same negotiation; we want the most recent.
    const events = await prisma.webhookEvent.findMany({
      where: {
        platform: 'thumbtack',
        eventType: 'NegotiationCreatedV4',
      },
      select: { id: true, payload: true, receivedAt: true },
      orderBy: { receivedAt: 'desc' },
    });

    console.log(`[backfill] scanning ${events.length} NegotiationCreatedV4 events`);

    const phoneByNegotiationId = new Map<string, string>();
    let parseFailures = 0;
    let nullPhoneCount = 0;

    for (const ev of events) {
      let negotiationId: string | undefined;
      let phone: string | undefined;
      try {
        const parsed = JSON.parse(ev.payload);
        const data = parsed?.data ?? parsed;
        negotiationId = data?.negotiationID;
        phone = data?.customer?.phone;
      } catch {
        parseFailures++;
        continue;
      }
      if (!negotiationId) continue;
      if (phoneByNegotiationId.has(negotiationId)) continue; // already took newest
      if (!phone) {
        nullPhoneCount++;
        phoneByNegotiationId.set(negotiationId, ''); // mark seen
        continue;
      }
      phoneByNegotiationId.set(negotiationId, phone);
    }

    const negotiationIdsWithRealPhone = [...phoneByNegotiationId.entries()]
      .filter(([, p]) => p !== '')
      .map(([id]) => id);

    console.log(
      `[backfill] negotiations parsed=${phoneByNegotiationId.size} ` +
        `withRealPhone=${negotiationIdsWithRealPhone.length} ` +
        `nullPhone=${nullPhoneCount} parseFailures=${parseFailures}`,
    );

    let restored = 0;
    let noopMatch = 0;
    let noopAlreadyReal = 0;
    let noLeadFound = 0;
    let leadsMissingPhone = 0;

    // Process in chunks to avoid massive single queries.
    const CHUNK = 500;
    for (let i = 0; i < negotiationIdsWithRealPhone.length; i += CHUNK) {
      const slice = negotiationIdsWithRealPhone.slice(i, i + CHUNK);
      const leads = await prisma.lead.findMany({
        where: {
          platform: 'thumbtack',
          externalRequestId: { in: slice },
        },
        select: {
          id: true,
          externalRequestId: true,
          customerPhone: true,
          customerPhoneSubstitute: true,
        },
      });

      const leadsByNegId = new Map(leads.map((l) => [l.externalRequestId, l]));

      for (const negotiationId of slice) {
        const realPhone = phoneByNegotiationId.get(negotiationId);
        if (!realPhone) continue;
        const lead = leadsByNegId.get(negotiationId);
        if (!lead) {
          noLeadFound++;
          continue;
        }

        if (lead.customerPhone === realPhone) {
          noopAlreadyReal++;
          continue;
        }

        // Two restore shapes:
        //   1. customerPhone holds a substitute (most common case post-bug)
        //      -> move it to substitute slot (if empty), set real
        //   2. customerPhone is null (webhook never wrote a phone, or row was
        //      created fresh from GET endpoint with no phone)
        //      -> just set real, nothing to move
        const moveToSubstitute =
          lead.customerPhone && !lead.customerPhoneSubstitute
            ? lead.customerPhone
            : undefined;

        if (!lead.customerPhone) leadsMissingPhone++;

        if (DRY_RUN) {
          restored++;
          continue;
        }

        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            customerPhone: realPhone,
            ...(moveToSubstitute ? { customerPhoneSubstitute: moveToSubstitute } : {}),
          },
        });
        restored++;
      }
    }

    // Sanity counter — webhook events whose phone matched what Lead already had.
    noopMatch = noopAlreadyReal;

    console.log(
      `[backfill-thumbtack-real-phone] done — ` +
        `${DRY_RUN ? '[DRY_RUN] would have ' : ''}restored=${restored} ` +
        `noopMatch=${noopMatch} noLeadFound=${noLeadFound} ` +
        `leadsThatWereMissingPhone=${leadsMissingPhone}`,
    );
  } catch (err: any) {
    console.error('[backfill-thumbtack-real-phone] FAILED:', err?.message ?? err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
