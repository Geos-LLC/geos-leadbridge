/**
 * One-shot: replay sf_inbound_events stuck on deferred:lead_not_found,
 * creating the missing Lead stub from the payload's (channel, external_request_id)
 * and applying the latest canonical status per (lead, sf_job_id).
 *
 * Mirrors what SfInboundStatusService.process() now does post-Option-2, but
 * runs as a direct Prisma script so we don't bootstrap NestJS (avoids cron
 * schedulers firing against prod during the backfill).
 *
 * Usage:
 *   npx ts-node scripts/backfill-sf-deferred.ts            # dry-run preview
 *   npx ts-node scripts/backfill-sf-deferred.ts --apply    # actually write
 *
 * Scope: all userIds with deferred:lead_not_found events. (Currently only
 * Spotless Homes uses SF inbound.)
 */

import { PrismaClient } from '../generated/prisma';
import { mapSfStatus } from '../src/integrations/service-flow/sf-status-map';

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}`);

  const events = await prisma.sfInboundEvent.findMany({
    where: { status: 'deferred', result: 'lead_not_found' },
    orderBy: { occurredAt: 'asc' },
  });

  console.log(`Found ${events.length} deferred:lead_not_found events.`);

  const stats: Record<string, number> = {
    skipped_no_identifiers: 0,
    skipped_unmappable: 0,
    skipped_missing_user: 0,
    skipped_no_subscription: 0,
    stub_created: 0,
    status_applied: 0,
    status_skipped_older: 0,
    status_skipped_non_primary: 0,
    status_skipped_no_change: 0,
    event_marked_applied: 0,
  };

  for (const event of events) {
    const payload: any = event.payloadJson;
    if (!payload?.channel || !payload?.external_request_id) {
      stats.skipped_no_identifiers++;
      continue;
    }
    if (!event.userId) {
      stats.skipped_missing_user++;
      continue;
    }
    if (!event.sfSubscriptionId) {
      stats.skipped_no_subscription++;
      continue;
    }

    const canonical = mapSfStatus(payload.status?.canonical || payload.status?.new);
    if (!canonical) {
      stats.skipped_unmappable++;
      continue;
    }

    const occurredAt = new Date(payload.occurred_at);
    const sfJobId = payload.sf_job_id;

    if (!APPLY) {
      console.log(
        `  [dry] event=${event.eventId.slice(0, 12)} platform=${payload.channel} ext=${payload.external_request_id} sf_job=${sfJobId} would_apply=${canonical}`,
      );
      stats.stub_created++;
      stats.status_applied++;
      stats.event_marked_applied++;
      continue;
    }

    try {
      // 1) Upsert the Lead. Create matches the same shape sf-inbound-status.service
      //    uses for its create-on-deferred branch.
      const lead = await prisma.lead.upsert({
        where: {
          platform_externalRequestId: {
            platform: payload.channel,
            externalRequestId: payload.external_request_id,
          },
        },
        create: {
          userId: event.userId,
          platform: payload.channel,
          externalRequestId: payload.external_request_id,
          customerName: '',
          message: '',
          rawJson: JSON.stringify({
            source: 'sf-inbound-backfill',
            sf_job_id: sfJobId,
            event_id: event.eventId,
          }),
          sfJobId,
        },
        update: {},
      });

      const isNewStub = !lead.statusUpdatedAt;
      if (isNewStub) stats.stub_created++;

      // 2) Primary-job guard: don't mutate Lead.status with a non-primary sf_job.
      if (lead.sfJobId && sfJobId && lead.sfJobId !== sfJobId) {
        stats.status_skipped_non_primary++;
        await markEventApplied(event.id, lead.id, 'lead_status_skip:non_primary_job');
        stats.event_marked_applied++;
        continue;
      }

      // 3) Loop guard: skip if this event is older than what we've already written.
      if (
        lead.statusSource === 'service_flow' &&
        lead.sfLastEventAt &&
        occurredAt <= lead.sfLastEventAt
      ) {
        stats.status_skipped_older++;
        await markEventApplied(event.id, lead.id, 'older_than_last_sf_event');
        stats.event_marked_applied++;
        continue;
      }

      // 4) No-change guard.
      if (canonical === lead.status && lead.sfJobId === sfJobId) {
        stats.status_skipped_no_change++;
        await markEventApplied(event.id, lead.id, 'status_unchanged');
        stats.event_marked_applied++;
        continue;
      }

      // 5) Write canonical status + audit log + mark event applied — one tx.
      const oldStatus = lead.status;
      await prisma.$transaction([
        prisma.lead.update({
          where: { id: lead.id },
          data: {
            status: canonical,
            statusSource: 'service_flow',
            statusUpdatedAt: occurredAt,
            sfJobId: lead.sfJobId || sfJobId,
            sfJobMappedAt: lead.sfJobMappedAt || new Date(),
            sfLastEventAt: occurredAt,
          },
        }),
        prisma.leadStatusAuditLog.create({
          data: {
            leadId: lead.id,
            oldStatus,
            newStatus: canonical,
            source: 'service_flow',
            sourceEventId: event.eventId,
            occurredAt,
          },
        }),
        prisma.sfInboundEvent.update({
          where: { id: event.id },
          data: {
            status: 'applied',
            result: `backfill:${oldStatus}→${canonical}`,
            leadId: lead.id,
          },
        }),
      ]);

      stats.status_applied++;
      stats.event_marked_applied++;
    } catch (err: any) {
      console.error(`  [err] event=${event.eventId.slice(0, 12)}: ${err.message?.slice(0, 200)}`);
    }
  }

  console.log('\n=== Stats ===');
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v}`);
}

async function markEventApplied(eventRowId: string, leadId: string, result: string) {
  await prisma.sfInboundEvent.update({
    where: { id: eventRowId },
    data: { status: 'applied', result, leadId },
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
