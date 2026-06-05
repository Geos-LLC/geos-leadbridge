/**
 * SfHistoricalSyncService tests.
 *
 * Covers:
 *   - enumeration: pending vs skipped vs linked decisions, idempotency
 *   - dashboard counts
 *   - manual-link safeguards (no-overwrite-different-sfJobId, status update via writeStatus)
 *   - bulk receiver: confidence-driven outcomes, conflict, not_found, status update
 */
import { SfHistoricalSyncService } from './sf-historical-sync.service';

function buildPrisma(initial: any = {}) {
  const leads = new Map<string, any>(Object.entries(initial.leads || {}));
  const updates: any[] = [];
  const prisma: any = {
    lead: {
      findMany: jest.fn(async (args: any) => {
        let rows = [...leads.values()];
        if (args?.where?.userId) rows = rows.filter((r) => r.userId === args.where.userId);
        if (args?.where?.status?.in) rows = rows.filter((r) => args.where.status.in.includes(r.status));
        if (args?.where?.status && typeof args.where.status === 'string') rows = rows.filter((r) => r.status === args.where.status);
        if (args?.where?.syncStatus !== undefined && !args.where.syncStatus?.in) {
          rows = rows.filter((r) => r.syncStatus === args.where.syncStatus);
        }
        if (args?.where?.syncStatus?.in) {
          rows = rows.filter((r) => args.where.syncStatus.in.includes(r.syncStatus));
        }
        // OR clause support (used by candidates() to express
        // "pending OR null" and the default-bucket query). Each branch
        // is a sub-where; a row matches if it matches ANY branch.
        if (Array.isArray(args?.where?.OR)) {
          const branches: any[] = args.where.OR;
          const matchBranch = (r: any, b: any): boolean => {
            if (b.syncStatus === null || b.syncStatus === undefined && 'syncStatus' in b) {
              return r.syncStatus === null;
            }
            if (b.syncStatus === null) return r.syncStatus === null;
            if (b.syncStatus?.in) return b.syncStatus.in.includes(r.syncStatus);
            if (b.syncStatus !== undefined) return r.syncStatus === b.syncStatus;
            return true;
          };
          rows = rows.filter((r) => branches.some((b) => matchBranch(r, b)));
        }
        return args?.select
          ? rows.map((r) => Object.keys(args.select).reduce((acc: any, k) => { acc[k] = r[k] ?? null; return acc; }, {}))
          : rows;
      }),
      findUnique: jest.fn(async ({ where }: any) => leads.get(where.id) || null),
      update: jest.fn(async ({ where, data }: any) => {
        updates.push({ where, data });
        const cur = leads.get(where.id);
        if (cur) leads.set(where.id, { ...cur, ...data });
        return cur;
      }),
    },
    sfConnection: {
      findUnique: jest.fn(async ({ where }: any) => initial.sfConnection?.[where.userId] || null),
    },
  };
  return { prisma, leads, updates };
}

function buildLeadStatus(writeApplied: boolean = true) {
  return {
    writeStatus: jest.fn(async (input: any) => ({
      leadId: input.leadId, applied: writeApplied, status: input.newStatus, platformStatus: null,
      auditLogId: 'aud-1', conflict: null, skipReason: writeApplied ? null : 'pipeline_downgrade',
    })),
    // sfJobOutcome mirror — historical-sync now calls this on the same paths
    // the live SF webhook uses, so the mock must implement it. Default returns
    // written=true; tests that assert stale-protection override via mockResolvedValueOnce.
    writeSfJobOutcomeMirror: jest.fn(async () => ({ written: true })),
  } as any;
}

describe('SfHistoricalSyncService', () => {
  describe('enumeration (connection-time + trigger)', () => {
    // 2026-06-05 rule refactor (revised post hard-skip semantics audit):
    // L2 stays as the canonical hard-skip case (opt_out). L4 (status=
    // 'cancelled') was previously expected to skip; under the revised
    // 2-case rule (test/noise + opt_out only) cancelled is a SF-authority
    // signal that should enumerate as 'pending' for matching. Per-status
    // 'cancelled / no_show / archived → pending' is exercised explicitly
    // in the "hard-skip rule narrowing" describe block below.
    it('marks actionable leads + cancelled as pending, hard-skips opt_out, leaves linked alone', async () => {
      const { prisma, leads, updates } = buildPrisma({
        leads: {
          'L1': { id: 'L1', userId: 'U1', status: 'scheduled', sfJobId: null, syncStatus: null },
          'L2': { id: 'L2', userId: 'U1', status: 'lost', lostReason: 'opt_out', sfJobId: null, syncStatus: null },
          'L3': { id: 'L3', userId: 'U1', status: 'completed', sfJobId: 'SF-111', syncStatus: null },
          'L4': { id: 'L4', userId: 'U1', status: 'cancelled', sfJobId: null, syncStatus: null },
          'L5': { id: 'L5', userId: 'U1', status: 'contacted', sfJobId: null, syncStatus: null },
        },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.enumerateOnConnect('U1');
      expect(r.scanned).toBe(5);
      expect(r.markedPending).toBe(3);   // L1 scheduled, L4 cancelled, L5 contacted
      expect(r.markedSkipped).toBe(1);   // L2 lost+opt_out only
      expect(r.alreadyLinked).toBe(1);   // L3 (had sfJobId)
      expect(leads.get('L1').syncStatus).toBe('pending');
      expect(leads.get('L2').syncStatus).toBe('skipped');
      expect(leads.get('L2').syncReason).toBe('terminal_lost_opt_out');
      expect(leads.get('L3').syncStatus).toBe('linked');  // backfilled from sfJobId
      expect(leads.get('L4').syncStatus).toBe('pending'); // revised: cancelled is SF-authority, not DNC
      expect(leads.get('L4').syncReason).toBe('connection_time');
      expect(leads.get('L5').syncStatus).toBe('pending');
    });

    it('idempotent: re-running does not churn already-pending rows', async () => {
      const { prisma } = buildPrisma({
        leads: {
          'L1': { id: 'L1', userId: 'U1', status: 'scheduled', sfJobId: null, syncStatus: 'pending' },
          // L2 carries opt_out so the row is correctly hard-skipped under the
          // new rule (a status='lost' with no lostReason would re-enumerate
          // to 'pending' on a fresh run, which would be a churn — not the
          // case this test wants to assert).
          'L2': { id: 'L2', userId: 'U1', status: 'lost', lostReason: 'opt_out', sfJobId: null, syncStatus: 'skipped' },
          'L3': { id: 'L3', userId: 'U1', status: 'completed', sfJobId: 'SF-A', syncStatus: 'linked' },
        },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.enumerateOnConnect('U1');
      expect(r.markedPending).toBe(0);   // L1 already pending
      expect(r.markedSkipped).toBe(0);   // L2 already skipped + still hard-skippable
      expect(r.alreadyLinked).toBe(1);   // L3
    });

    it('forceResync re-marks even already-pending rows', async () => {
      const { prisma, leads } = buildPrisma({
        leads: {
          'L1': { id: 'L1', userId: 'U1', status: 'scheduled', sfJobId: null, syncStatus: 'no_match' },
        },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.enumerateOnTrigger('U1', { forceResync: true });
      expect(r.newlyPending).toBe(1);
      expect(leads.get('L1').syncStatus).toBe('pending');
    });

    it('failed → retried as pending on next enumeration', async () => {
      const { prisma, leads } = buildPrisma({
        leads: {
          'L1': { id: 'L1', userId: 'U1', status: 'scheduled', sfJobId: null, syncStatus: 'failed' },
        },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.enumerateOnConnect('U1');
      expect(r.markedPending).toBe(1);
      expect(leads.get('L1').syncStatus).toBe('pending');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Hard-skip rule narrowing (2026-06-05 Phase 1 refactor, revised after
  // the hard-skip semantics audit)
  //
  // `syncStatus='skipped'` now means TRUE hard exclusion from SF identity
  // reconciliation. TWO sources only:
  //
  //   (a) platform='test'                              — not a real customer
  //   (b) status='lost' AND lostReason='opt_out'       — explicit customer DNC
  //
  // Deliberately NOT hard-skipped (revised post-audit):
  //   - status IN {cancelled, no_show, archived}      — SF-authority signals
  //     or operator hides. The customer is real and likely known to SF;
  //     reconciliation should run. ('cancelled' specifically arrives FROM
  //     SF via service_cancelled webhook — by construction the customer
  //     is in SF's records.)
  //   - status='lost' with non-opt_out lostReason (null / hired_someone /
  //     canceled) — platform-algorithmic or classifier-driven terminal,
  //     not customer DNC.
  //
  // Tests below lock in each branch of the revised 2-case rule + assert
  // non-behavior-change on adjacent fields.
  // ═══════════════════════════════════════════════════════════════════════
  describe('enumeration — hard-skip rule narrowing (2026-06-05 revised)', () => {
    it("status='lost' + lostReason='opt_out' → skipped with reason 'terminal_lost_opt_out'", async () => {
      const { prisma, leads } = buildPrisma({
        leads: {
          'L_OPTOUT': { id: 'L_OPTOUT', userId: 'U1', status: 'lost', lostReason: 'opt_out', platform: 'yelp', sfJobId: null, syncStatus: null },
        },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.enumerateOnConnect('U1');
      expect(r.markedSkipped).toBe(1);
      expect(r.markedPending).toBe(0);
      expect(leads.get('L_OPTOUT').syncStatus).toBe('skipped');
      expect(leads.get('L_OPTOUT').syncReason).toBe('terminal_lost_opt_out');
    });

    it("platform='test' → skipped with reason 'test_noise' regardless of status/lostReason", async () => {
      const { prisma, leads } = buildPrisma({
        leads: {
          'L_TEST1': { id: 'L_TEST1', userId: 'U1', status: 'new', platform: 'test', sfJobId: null, syncStatus: null },
          'L_TEST2': { id: 'L_TEST2', userId: 'U1', status: 'lost', lostReason: 'hired_someone', platform: 'test', sfJobId: null, syncStatus: null },
        },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.enumerateOnConnect('U1');
      expect(r.markedSkipped).toBe(2);
      expect(leads.get('L_TEST1').syncStatus).toBe('skipped');
      expect(leads.get('L_TEST1').syncReason).toBe('test_noise');
      expect(leads.get('L_TEST2').syncStatus).toBe('skipped');
      expect(leads.get('L_TEST2').syncReason).toBe('test_noise');
    });

    it("status IN {cancelled, no_show, archived} → pending (NOT hard-skip — SF-authority signals)", async () => {
      // Revised 2026-06-05 post-audit: cancelled / no_show / archived are
      // LB lifecycle terminals but NOT customer DNC. SF identity may still
      // exist (and for 'cancelled' it almost certainly does, since that
      // status arrives FROM SF via service_cancelled webhook). All three
      // must enumerate as 'pending' so SF can match them. In production
      // these statuses typically arrive on leads that already carry
      // sfJobId — but if they don't (e.g., archived-without-link in a
      // future scenario), they should still enter the SF matcher.
      const { prisma, leads } = buildPrisma({
        leads: {
          'L_CAN': { id: 'L_CAN', userId: 'U1', status: 'cancelled', platform: 'thumbtack', sfJobId: null, syncStatus: null },
          'L_NS':  { id: 'L_NS',  userId: 'U1', status: 'no_show',   platform: 'thumbtack', sfJobId: null, syncStatus: null },
          'L_ARC': { id: 'L_ARC', userId: 'U1', status: 'archived',  platform: 'yelp',      sfJobId: null, syncStatus: null },
        },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.enumerateOnConnect('U1');
      expect(r.markedSkipped).toBe(0);
      expect(r.markedPending).toBe(3);
      expect(leads.get('L_CAN').syncStatus).toBe('pending');
      expect(leads.get('L_CAN').syncReason).toBe('connection_time');
      expect(leads.get('L_NS').syncStatus).toBe('pending');
      expect(leads.get('L_NS').syncReason).toBe('connection_time');
      expect(leads.get('L_ARC').syncStatus).toBe('pending');
      expect(leads.get('L_ARC').syncReason).toBe('connection_time');
    });

    it("status='lost' + lostReason='hired_someone' → pending (re-engageable, SF candidate)", async () => {
      // This is the LB-classifier-driven hired_someone path AND the Yelp
      // Archived→lost+hired_someone remap path — both end up status='lost'
      // with lostReason='hired_someone' and must NOT hard-skip.
      const { prisma, leads } = buildPrisma({
        leads: {
          'L_HIRED_TT': { id: 'L_HIRED_TT', userId: 'U1', status: 'lost', lostReason: 'hired_someone', platform: 'thumbtack', sfJobId: null, syncStatus: null },
          'L_HIRED_YELP': { id: 'L_HIRED_YELP', userId: 'U1', status: 'lost', lostReason: 'hired_someone', platform: 'yelp', sfJobId: null, syncStatus: null },
        },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.enumerateOnConnect('U1');
      expect(r.markedPending).toBe(2);
      expect(r.markedSkipped).toBe(0);
      expect(leads.get('L_HIRED_TT').syncStatus).toBe('pending');
      expect(leads.get('L_HIRED_TT').syncReason).toBe('connection_time');
      expect(leads.get('L_HIRED_YELP').syncStatus).toBe('pending');
      // Adjacent fields untouched — only syncStatus/syncReason/syncAttemptedAt are written.
      expect(leads.get('L_HIRED_TT').status).toBe('lost');
      expect(leads.get('L_HIRED_TT').lostReason).toBe('hired_someone');
    });

    it("status='lost' + lostReason=null → pending (Thumbtack platform-sync 'No hire' case)", async () => {
      // Thumbtack 'Not hired' / 'Closed' / 'No hire' maps to status='lost'
      // with NULL lostReason (no specific reason carried by TT). Must enumerate
      // as pending so SF matcher can take a swing.
      const { prisma, leads } = buildPrisma({
        leads: {
          'L_NOHIRE': { id: 'L_NOHIRE', userId: 'U1', status: 'lost', lostReason: null, platform: 'thumbtack', sfJobId: null, syncStatus: null },
        },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.enumerateOnConnect('U1');
      expect(r.markedPending).toBe(1);
      expect(r.markedSkipped).toBe(0);
      expect(leads.get('L_NOHIRE').syncStatus).toBe('pending');
      expect(leads.get('L_NOHIRE').status).toBe('lost'); // unchanged
    });

    it("status='lost' + lostReason='canceled' → pending (edge case, not opt_out)", async () => {
      // 'canceled' lostReason (1 Spotless row) is ambiguous — could be a
      // booking cancellation that LB classified as lost. NOT an opt_out
      // signal. Must enumerate as pending so SF decides; operator can
      // manually re-skip if needed.
      const { prisma, leads } = buildPrisma({
        leads: {
          'L_CXL': { id: 'L_CXL', userId: 'U1', status: 'lost', lostReason: 'canceled', platform: 'thumbtack', sfJobId: null, syncStatus: null },
        },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.enumerateOnConnect('U1');
      expect(r.markedPending).toBe(1);
      expect(r.markedSkipped).toBe(0);
      expect(leads.get('L_CXL').syncStatus).toBe('pending');
    });

    it('linked / lead_linked rows are NOT touched by re-enumeration (no idempotency churn)', async () => {
      // The actionable branch's idempotency check skips already-classified
      // rows. linked rows route through the sfJobId branch (preserves
      // syncStatus='linked'). lead_linked rows hit the actionable-branch
      // idempotency guard and are left alone.
      const { prisma, leads } = buildPrisma({
        leads: {
          'L_LINKED':      { id: 'L_LINKED',      userId: 'U1', status: 'completed', sfJobId: 'SF-1', syncStatus: 'linked',      lostReason: null, platform: 'thumbtack' },
          'L_LEADLINKED':  { id: 'L_LEADLINKED',  userId: 'U1', status: 'engaged',   sfJobId: null,   syncStatus: 'lead_linked', lostReason: null, platform: 'thumbtack', sfLeadId: '107' },
          'L_NEEDS':       { id: 'L_NEEDS',       userId: 'U1', status: 'contacted', sfJobId: null,   syncStatus: 'needs_review', lostReason: null, platform: 'thumbtack' },
        },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.enumerateOnConnect('U1');
      // sfJobId path runs for L_LINKED but its syncStatus is already 'linked'
      // so no update fires (existing logic). lead_linked and needs_review
      // hit the idempotency guard and are left untouched.
      expect(r.markedPending).toBe(0);
      expect(r.markedSkipped).toBe(0);
      expect(r.alreadyLinked).toBe(1);
      expect(leads.get('L_LINKED').syncStatus).toBe('linked');
      expect(leads.get('L_LINKED').sfJobId).toBe('SF-1');         // unchanged
      expect(leads.get('L_LEADLINKED').syncStatus).toBe('lead_linked'); // unchanged
      expect(leads.get('L_LEADLINKED').sfLeadId).toBe('107');     // unchanged
      expect(leads.get('L_NEEDS').syncStatus).toBe('needs_review'); // unchanged
    });

    it('enumerate ONLY writes syncStatus/syncReason/syncAttemptedAt — never touches Lead.status/lostReason/sfJobId/etc.', async () => {
      // Behavior preservation contract: the rule refactor must not silently
      // modify any field that downstream consumers (AI gates, FU gates,
      // status pill, isSfLinkedLead) read. Confirms the update payload
      // never includes status, lostReason, platform, sfJobId, sfCustomerId,
      // sfLeadId, threadId, reengageAt, statusSource, or any non-sync field.
      const { prisma, updates } = buildPrisma({
        leads: {
          'L_HIRED': { id: 'L_HIRED', userId: 'U1', status: 'lost', lostReason: 'hired_someone', platform: 'yelp', sfJobId: null, syncStatus: null, reengageAt: new Date('2026-07-01'), statusSource: 'platform_sync' },
          'L_OPTOUT': { id: 'L_OPTOUT', userId: 'U1', status: 'lost', lostReason: 'opt_out', platform: 'yelp', sfJobId: null, syncStatus: null },
          'L_CXL': { id: 'L_CXL', userId: 'U1', status: 'cancelled', platform: 'thumbtack', sfJobId: null, syncStatus: null },
        },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      await svc.enumerateOnConnect('U1');

      // Every update.data must be a strict subset of {syncStatus, syncReason, syncAttemptedAt}.
      const allowedKeys = new Set(['syncStatus', 'syncReason', 'syncAttemptedAt']);
      for (const u of updates) {
        const dataKeys = Object.keys(u.data);
        for (const k of dataKeys) {
          expect(allowedKeys.has(k)).toBe(true);
        }
      }
      // No call mutates Lead.status, lostReason, platform, sfJobId, sfCustomerId,
      // sfLeadId, threadId, reengageAt — the predicate-driving fields stay frozen.
      expect(updates.length).toBeGreaterThan(0); // sanity: enum actually ran
    });
  });

  describe('manual-link safeguards', () => {
    it('refuses to overwrite a DIFFERENT existing sfJobId (conflict)', async () => {
      const { prisma, leads, updates } = buildPrisma({
        leads: {
          'L1': { id: 'L1', userId: 'U1', status: 'scheduled', sfJobId: 'SF-EXISTING', sfCustomerId: null, syncStatus: 'linked' },
        },
      });
      const ls = buildLeadStatus();
      const svc = new SfHistoricalSyncService(prisma, ls);
      const r = await svc.manualLink('admin-1', { lbLeadId: 'L1', sfJobId: 'SF-NEW' });
      expect(r.ok).toBe(false);
      expect(r.conflict).toBe('existing_sfJobId_differs');
      // Original sfJobId untouched.
      expect(leads.get('L1').sfJobId).toBe('SF-EXISTING');
      // writeStatus never called.
      expect(ls.writeStatus).not.toHaveBeenCalled();
    });

    it('idempotent: re-linking with same sfJobId is allowed', async () => {
      const { prisma, leads } = buildPrisma({
        leads: { 'L1': { id: 'L1', userId: 'U1', status: 'scheduled', sfJobId: 'SF-A', sfJobMappedAt: new Date(), syncStatus: 'linked' } },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.manualLink('admin-1', { lbLeadId: 'L1', sfJobId: 'SF-A' });
      expect(r.ok).toBe(true);
      expect(r.syncStatus).toBe('linked');
    });

    it('links + applies SF status through writeStatus when sfStatus provided', async () => {
      const { prisma, leads } = buildPrisma({
        leads: { 'L1': { id: 'L1', userId: 'U1', status: 'scheduled', sfJobId: null, syncStatus: 'pending' } },
      });
      const ls = buildLeadStatus(true);
      const svc = new SfHistoricalSyncService(prisma, ls);
      const r = await svc.manualLink('admin-1', { lbLeadId: 'L1', sfJobId: 'SF-A', sfStatus: 'completed' });
      expect(r.ok).toBe(true);
      expect(r.statusUpdated).toBe(true);
      expect(r.newStatus).toBe('completed');
      expect(ls.writeStatus).toHaveBeenCalledWith(expect.objectContaining({
        leadId: 'L1', newStatus: 'completed', source: 'service_flow',
      }));
      expect(leads.get('L1').sfJobId).toBe('SF-A');
      expect(leads.get('L1').syncStatus).toBe('linked');
    });

    it('payment_status=paid → completed via writeStatus', async () => {
      const { prisma } = buildPrisma({
        leads: { 'L1': { id: 'L1', userId: 'U1', status: 'scheduled', sfJobId: null, syncStatus: 'pending' } },
      });
      const ls = buildLeadStatus(true);
      const svc = new SfHistoricalSyncService(prisma, ls);
      const r = await svc.manualLink('admin-1', { lbLeadId: 'L1', sfJobId: 'SF-A', sfPaymentStatus: 'paid' });
      expect(r.newStatus).toBe('completed');
    });

    it('respects writeStatus rejection (e.g. pipeline_downgrade) — link still applies but status not updated', async () => {
      const { prisma } = buildPrisma({
        leads: { 'L1': { id: 'L1', userId: 'U1', status: 'completed', sfJobId: null, syncStatus: 'pending' } },
      });
      const ls = buildLeadStatus(false); // writeStatus says applied=false
      const svc = new SfHistoricalSyncService(prisma, ls);
      const r = await svc.manualLink('admin-1', { lbLeadId: 'L1', sfJobId: 'SF-A', sfStatus: 'scheduled' });
      expect(r.ok).toBe(true);
      expect(r.statusUpdated).toBe(false);
      expect(r.linkedSfJobId).toBe('SF-A');
    });

    it('returns lead_not_found when leadId missing', async () => {
      const { prisma } = buildPrisma({ leads: {} });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.manualLink('admin-1', { lbLeadId: 'MISSING', sfJobId: 'SF-A' });
      expect(r.ok).toBe(false);
      expect(r.conflict).toBe('lead_not_found');
    });
  });

  describe('bulk-link receiver', () => {
    it('confidence=exact → links + applies status', async () => {
      const { prisma, leads } = buildPrisma({
        leads: { 'L1': { id: 'L1', userId: 'U1', status: 'scheduled', sfJobId: null, syncStatus: 'pending' } },
      });
      const ls = buildLeadStatus(true);
      const svc = new SfHistoricalSyncService(prisma, ls);
      const r = await svc.applyBulkLink({
        rows: [{ lb_lead_id: 'L1', sf_job_id: 'SF-A', confidence: 'exact', match_basis: 'externalRequestId', sf_status: 'completed' }],
      });
      expect(r.summary.linked).toBe(1);
      expect(r.summary.status_updates_applied).toBe(1);
      expect(leads.get('L1').sfJobId).toBe('SF-A');
      expect(leads.get('L1').syncStatus).toBe('linked');
    });

    it('confidence=medium → needs_review (no sfJobId write)', async () => {
      const { prisma, leads } = buildPrisma({
        leads: { 'L1': { id: 'L1', userId: 'U1', status: 'scheduled', sfJobId: null, syncStatus: 'pending' } },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.applyBulkLink({
        rows: [{ lb_lead_id: 'L1', sf_job_id: 'SF-A', confidence: 'medium', match_basis: 'phone_name' }],
      });
      expect(r.summary.needs_review).toBe(1);
      expect(leads.get('L1').sfJobId).toBeNull();
      expect(leads.get('L1').syncStatus).toBe('needs_review');
    });

    it('confidence=none → no_match', async () => {
      const { prisma, leads } = buildPrisma({
        leads: { 'L1': { id: 'L1', userId: 'U1', status: 'scheduled', sfJobId: null, syncStatus: 'pending' } },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.applyBulkLink({
        rows: [{ lb_lead_id: 'L1', sf_job_id: '', confidence: 'none', match_basis: 'none' }],
      });
      expect(r.summary.no_match).toBe(1);
      expect(leads.get('L1').sfJobId).toBeNull();
      expect(leads.get('L1').syncStatus).toBe('no_match');
    });

    // 2026-06-04 regression: confidence='low' is documented to route to
    // needs_review the same way 'medium' does. Previously only exercised via
    // the mixed-batch test; pinning explicitly so a future refactor of the
    // confidence ladder doesn't silently move 'low' into a different bucket.
    it("confidence=low → needs_review (no sfJobId write)", async () => {
      const { prisma, leads } = buildPrisma({
        leads: { 'L1': { id: 'L1', userId: 'U1', status: 'scheduled', sfJobId: null, syncStatus: 'pending' } },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.applyBulkLink({
        rows: [{ lb_lead_id: 'L1', sf_job_id: 'SF-A', confidence: 'low', match_basis: 'name_platform' }],
      });
      expect(r.summary.needs_review).toBe(1);
      expect(r.summary.linked).toBe(0);
      expect(r.summary.no_match).toBe(0);
      expect(leads.get('L1').sfJobId).toBeNull();
      expect(leads.get('L1').syncStatus).toBe('needs_review');
      expect(leads.get('L1').syncReason).toBe('sf_low_confidence:name_platform');
    });

    // 2026-06-04 regression: when row processing throws (e.g. DB connection
    // glitch on the per-row update), the receiver must NOT abort the batch —
    // it must catch, mark that row as 'failed' in the response, and keep
    // processing the next rows.
    //
    // KNOWN CONTRACT DRIFT (intentionally pinned, not fixed here): the catch
    // block only adds 'failed' to the response payload — it does NOT update
    // the Lead row's syncStatus. The lead therefore stays at its prior
    // syncStatus (typically 'pending'), and the enumeration retry logic
    // (sf-historical-sync.service.ts:131 — "syncStatus !== 'failed'") never
    // sees a 'failed' Lead row to retry. The failed state exists in
    // BulkLinkRowResult.sync_status but is unreachable on the Lead model
    // through the bulk-link path. Surfaced 2026-06-04 audit; a future PR
    // can either (a) add `await prisma.lead.update({... syncStatus: 'failed'})`
    // in the catch block, or (b) drop 'failed' from SYNC_STATUSES if no
    // writer exists. Decision deferred.
    it("row processing error → response row 'failed'; Lead.syncStatus NOT mutated (pre-update throw)", async () => {
      const { prisma, leads } = buildPrisma({
        leads: {
          'L1': { id: 'L1', userId: 'U1', status: 'scheduled', sfJobId: null, syncStatus: 'pending' },
          'L2': { id: 'L2', userId: 'U1', status: 'contacted', sfJobId: null, syncStatus: 'pending' },
        },
      });
      // Make ONLY the first lead.update call throw (the L1 row). Subsequent
      // calls (L2) succeed normally. This verifies error containment: one
      // bad row does not poison the rest of the batch.
      let updateCalls = 0;
      const realUpdate = prisma.lead.update;
      prisma.lead.update = jest.fn(async (args: any) => {
        updateCalls++;
        if (updateCalls === 1) throw new Error('db connection reset');
        return realUpdate(args);
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.applyBulkLink({
        rows: [
          { lb_lead_id: 'L1', sf_job_id: 'SF-A', confidence: 'exact', match_basis: 'externalRequestId' },
          { lb_lead_id: 'L2', sf_job_id: 'SF-B', confidence: 'exact', match_basis: 'externalRequestId' },
        ],
      });
      // Summary: L1 failed, L2 linked.
      expect(r.summary.total).toBe(2);
      expect(r.summary.failed).toBe(1);
      expect(r.summary.linked).toBe(1);
      // Response row for L1 reports failed with detail carrying the error message.
      const l1Row = r.rows.find(x => x.lb_lead_id === 'L1');
      expect(l1Row?.result).toBe('failed');
      expect(l1Row?.sync_status).toBe('failed');
      expect(l1Row?.detail).toContain('db connection reset');
      // ok=false because at least one row failed.
      expect(r.ok).toBe(false);
      // KNOWN DRIFT: Lead row's syncStatus is UNCHANGED (still 'pending'),
      // because the catch block doesn't write to the Lead. If a future PR
      // closes the drift, this assertion flips to 'failed'.
      expect(leads.get('L1').syncStatus).toBe('pending');
      expect(leads.get('L1').sfJobId).toBeNull();
      // L2 unaffected by L1's failure — error containment proved.
      expect(leads.get('L2').syncStatus).toBe('linked');
      expect(leads.get('L2').sfJobId).toBe('SF-B');
    });

    it('confidence=exact but lead.sfJobId already set to DIFFERENT id → conflict (no overwrite)', async () => {
      const { prisma, leads } = buildPrisma({
        leads: { 'L1': { id: 'L1', userId: 'U1', status: 'scheduled', sfJobId: 'SF-OLD', syncStatus: 'linked' } },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.applyBulkLink({
        rows: [{ lb_lead_id: 'L1', sf_job_id: 'SF-NEW', confidence: 'exact', match_basis: 'externalRequestId' }],
      });
      expect(r.summary.conflict).toBe(1);
      expect(leads.get('L1').sfJobId).toBe('SF-OLD');
    });

    it('lead_not_found → not_found bucket', async () => {
      const { prisma } = buildPrisma({ leads: {} });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.applyBulkLink({
        rows: [{ lb_lead_id: 'GONE', sf_job_id: 'SF-A', confidence: 'exact', match_basis: 'externalRequestId' }],
      });
      expect(r.summary.not_found).toBe(1);
    });

    // ───────────────────────────────────────────────────────────────────
    // PR B (2026-06-04): match_type='lead_only' — SF Lead identity only.
    // No SF Customer/Job yet. LB persists the lead identity for visibility
    // + matcher-exclusion, but behaviorally treats the row as LB-only.
    // ───────────────────────────────────────────────────────────────────
    describe("match_type='lead_only' — SF Lead identity only (PR B)", () => {
      it('writes sfLeadId/StageName/MatchedAt + syncStatus=lead_linked; does NOT touch job/customer/outcome; does NOT call writeStatus', async () => {
        const { prisma, leads, updates } = buildPrisma({
          leads: {
            'L1': {
              id: 'L1', userId: 'U1', status: 'completed',
              sfJobId: null, sfCustomerId: null, sfJobOutcome: null, sfJobMappedAt: null,
              sfLeadId: null, sfLeadStageName: null, sfLeadMatchedAt: null,
              syncStatus: 'pending',
            },
          },
        });
        const ls = buildLeadStatus(true);
        const svc = new SfHistoricalSyncService(prisma, ls);
        const r = await svc.applyBulkLink({
          rows: [{
            lb_lead_id: 'L1',
            match_type: 'lead_only',
            sf_lead_id: 107,
            sf_lead_stage_name: 'Contacted',
            sf_job_id: '',                       // ignored on lead_only branch
            confidence: 'high',
            match_basis: 'phone_name',
          }],
        });

        // Response shape
        expect(r.summary.total).toBe(1);
        expect(r.summary.lead_linked).toBe(1);
        expect(r.summary.linked).toBe(0);
        expect(r.summary.needs_review).toBe(0);
        expect(r.summary.no_match).toBe(0);
        expect(r.rows[0].result).toBe('lead_linked');
        expect(r.rows[0].sync_status).toBe('lead_linked');
        expect(r.rows[0].detail).toContain('sf_lead_id=107');
        expect(r.rows[0].detail).toContain('stage=Contacted');

        // Lead row — fields WRITTEN
        const final = leads.get('L1');
        expect(final.syncStatus).toBe('lead_linked');
        expect(final.sfLeadId).toBe('107');                    // coerced to string
        expect(final.sfLeadStageName).toBe('Contacted');
        expect(final.sfLeadMatchedAt).toBeInstanceOf(Date);
        expect(final.syncReason).toBe('sf_lead_only:phone_name');
        expect(final.syncAttemptedAt).toBeInstanceOf(Date);

        // Lead row — fields DELIBERATELY NOT TOUCHED
        expect(final.sfJobId).toBeNull();
        expect(final.sfCustomerId).toBeNull();
        expect(final.sfJobOutcome).toBeNull();
        expect(final.sfJobMappedAt).toBeNull();

        // Side-effect services — NOT INVOKED
        expect(ls.writeStatus).not.toHaveBeenCalled();
        expect(ls.writeSfJobOutcomeMirror).not.toHaveBeenCalled();

        // Single update call (the lead_only branch makes one update; the
        // customer_job branch would have made one too — assert no double-write)
        expect(updates).toHaveLength(1);
      });

      it('lead_only with NULL sf_lead_id → failed (cannot persist lead identity without an ID)', async () => {
        const { prisma, leads } = buildPrisma({
          leads: { 'L1': { id: 'L1', userId: 'U1', status: 'completed', sfJobId: null, syncStatus: 'pending' } },
        });
        const ls = buildLeadStatus(true);
        const svc = new SfHistoricalSyncService(prisma, ls);
        const r = await svc.applyBulkLink({
          rows: [{
            lb_lead_id: 'L1',
            match_type: 'lead_only',
            sf_lead_id: null,
            sf_job_id: '',
            confidence: 'high',
            match_basis: 'phone',
          }],
        });
        expect(r.summary.failed).toBe(1);
        expect(r.summary.lead_linked).toBe(0);
        expect(r.rows[0].result).toBe('failed');
        expect(r.rows[0].detail).toBe('lead_only_missing_sf_lead_id');
        // Lead unchanged
        expect(leads.get('L1').syncStatus).toBe('pending');
        expect(leads.get('L1').sfLeadId ?? null).toBeNull();
      });

      it('mixed batch: lead_only + customer_job + medium + none in one call — each row routes correctly', async () => {
        const { prisma, leads } = buildPrisma({
          leads: {
            'LO':  { id: 'LO',  userId: 'U1', status: 'contacted', sfJobId: null, syncStatus: 'pending' },
            'CJ':  { id: 'CJ',  userId: 'U1', status: 'scheduled', sfJobId: null, syncStatus: 'pending' },
            'MED': { id: 'MED', userId: 'U1', status: 'new',       sfJobId: null, syncStatus: 'pending' },
            'NON': { id: 'NON', userId: 'U1', status: 'engaged',   sfJobId: null, syncStatus: 'pending' },
          },
        });
        const ls = buildLeadStatus(true);
        const svc = new SfHistoricalSyncService(prisma, ls);
        const r = await svc.applyBulkLink({
          rows: [
            { lb_lead_id: 'LO',  match_type: 'lead_only',    sf_lead_id: 107, sf_lead_stage_name: 'Contacted', sf_job_id: '', confidence: 'high',   match_basis: 'phone_name' },
            { lb_lead_id: 'CJ',  match_type: 'customer_job', sf_job_id: 'SF-1', sf_customer_id: 'C-1',         confidence: 'high',   match_basis: 'externalRequestId', sf_status: 'completed' },
            { lb_lead_id: 'MED', sf_job_id: 'SF-2',                                                            confidence: 'medium', match_basis: 'phone_name' },
            { lb_lead_id: 'NON', sf_job_id: '',                                                                confidence: 'none',   match_basis: 'none' },
          ],
        });

        expect(r.summary.total).toBe(4);
        expect(r.summary.lead_linked).toBe(1);
        expect(r.summary.linked).toBe(1);
        expect(r.summary.needs_review).toBe(1);
        expect(r.summary.no_match).toBe(1);

        // Per-row sync_status
        expect(leads.get('LO').syncStatus).toBe('lead_linked');
        expect(leads.get('LO').sfLeadId).toBe('107');
        expect(leads.get('LO').sfJobId).toBeNull();           // critical: lead_only does NOT touch job
        expect(leads.get('CJ').syncStatus).toBe('linked');
        expect(leads.get('CJ').sfJobId).toBe('SF-1');
        expect(leads.get('CJ').sfLeadId ?? null).toBeNull();  // customer_job does NOT touch sfLeadId
        expect(leads.get('MED').syncStatus).toBe('needs_review');
        expect(leads.get('NON').syncStatus).toBe('no_match');

        // writeStatus called ONCE — for the customer_job row only (it carried sf_status)
        // The lead_only row carried NO sf_status semantics and MUST not invoke writeStatus.
        expect(ls.writeStatus).toHaveBeenCalledTimes(1);
        expect(ls.writeStatus).toHaveBeenCalledWith(expect.objectContaining({ leadId: 'CJ' }));
      });

      it("backward compat: row without match_type defaults to customer_job behavior (existing high-confidence path)", async () => {
        // Pre-PR-B SF deployments emit rows without a match_type field. The
        // receiver must treat those identically to today (customer_job path).
        const { prisma, leads } = buildPrisma({
          leads: { 'L1': { id: 'L1', userId: 'U1', status: 'scheduled', sfJobId: null, syncStatus: 'pending' } },
        });
        const ls = buildLeadStatus(true);
        const svc = new SfHistoricalSyncService(prisma, ls);
        const r = await svc.applyBulkLink({
          rows: [{
            lb_lead_id: 'L1',
            // NO match_type field — represents pre-PR-B SF payload
            sf_job_id: 'SF-A',
            sf_customer_id: 'C-A',
            confidence: 'high',
            match_basis: 'phone_name',
            sf_status: 'scheduled',
          }],
        });
        expect(r.summary.linked).toBe(1);
        expect(r.summary.lead_linked).toBe(0);
        expect(leads.get('L1').syncStatus).toBe('linked');
        expect(leads.get('L1').sfJobId).toBe('SF-A');
        expect(leads.get('L1').sfLeadId ?? null).toBeNull();
      });
    });

    it('mixed batch: handles all outcomes in one call', async () => {
      const { prisma, leads } = buildPrisma({
        leads: {
          'L1': { id: 'L1', userId: 'U1', status: 'scheduled', sfJobId: null, syncStatus: 'pending' },
          'L2': { id: 'L2', userId: 'U1', status: 'scheduled', sfJobId: 'SF-OLD', syncStatus: 'linked' },
          'L3': { id: 'L3', userId: 'U1', status: 'contacted', sfJobId: null, syncStatus: 'pending' },
        },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus(true));
      const r = await svc.applyBulkLink({
        rows: [
          { lb_lead_id: 'L1', sf_job_id: 'SF-A', confidence: 'exact', match_basis: 'externalRequestId', sf_status: 'completed' },
          { lb_lead_id: 'L2', sf_job_id: 'SF-B', confidence: 'exact', match_basis: 'phone' },           // conflict
          { lb_lead_id: 'L3', sf_job_id: 'SF-C', confidence: 'low', match_basis: 'name_platform' },     // needs_review
          { lb_lead_id: 'GONE', sf_job_id: 'SF-D', confidence: 'exact', match_basis: 'phone' },         // not_found
        ],
      });
      expect(r.summary.total).toBe(4);
      expect(r.summary.linked).toBe(1);
      expect(r.summary.conflict).toBe(1);
      expect(r.summary.needs_review).toBe(1);
      expect(r.summary.not_found).toBe(1);
    });
  });

  // ── sfJobOutcome mirror parity with live SF webhook ─────────────────
  // Live sf-inbound writes BOTH Lead.status (via writeStatus) AND
  // Lead.sfJobOutcome (via writeSfJobOutcomeMirror — stale-protected,
  // independent of canonical write guards). Historical sync must mirror
  // the same behavior so SF's lifecycle view is visible whether the lead
  // arrived via live webhook or backfill reconciliation.
  describe('sfJobOutcome mirror parity with live webhook', () => {
    it('manualLink with sfStatus writes both writeStatus AND writeSfJobOutcomeMirror', async () => {
      const { prisma } = buildPrisma({
        leads: { 'L1': { id: 'L1', userId: 'U1', status: 'engaged', sfJobId: null, syncStatus: 'pending' } },
      });
      const ls = buildLeadStatus(true);
      const svc = new SfHistoricalSyncService(prisma, ls);
      await svc.manualLink('admin-1', { lbLeadId: 'L1', sfJobId: 'SF-A', sfStatus: 'scheduled' });
      expect(ls.writeSfJobOutcomeMirror).toHaveBeenCalledWith(
        'L1', 'scheduled', expect.any(Date),
        expect.objectContaining({ sfJobId: 'SF-A', userId: 'U1' }),
      );
      expect(ls.writeStatus).toHaveBeenCalledWith(
        expect.objectContaining({ newStatus: 'scheduled', source: 'service_flow' }),
      );
    });

    it('applyBulkLink scheduled writes mirror with same canonical value', async () => {
      const { prisma } = buildPrisma({
        leads: { 'L1': { id: 'L1', userId: 'U1', status: 'new', sfJobId: null, syncStatus: 'pending' } },
      });
      const ls = buildLeadStatus(true);
      const svc = new SfHistoricalSyncService(prisma, ls);
      const occurredAt = new Date('2026-05-25T17:30:19Z');
      await svc.applyBulkLink({
        rows: [{
          lb_lead_id: 'L1', sf_job_id: 'SF-A', confidence: 'exact',
          match_basis: 'externalRequestId', sf_status: 'scheduled',
          occurred_at: occurredAt.toISOString(),
        }],
      });
      expect(ls.writeSfJobOutcomeMirror).toHaveBeenCalledWith(
        'L1', 'scheduled', occurredAt,
        expect.objectContaining({ sfJobId: 'SF-A' }),
      );
    });

    it('applyBulkLink completed writes mirror with completed canonical', async () => {
      const { prisma } = buildPrisma({
        leads: { 'L1': { id: 'L1', userId: 'U1', status: 'scheduled', sfJobId: null, syncStatus: 'pending' } },
      });
      const ls = buildLeadStatus(true);
      const svc = new SfHistoricalSyncService(prisma, ls);
      await svc.applyBulkLink({
        rows: [{
          lb_lead_id: 'L1', sf_job_id: 'SF-A', confidence: 'exact',
          match_basis: 'externalRequestId', sf_status: 'completed',
        }],
      });
      expect(ls.writeSfJobOutcomeMirror).toHaveBeenCalledWith(
        'L1', 'completed', expect.any(Date),
        expect.objectContaining({ sfJobId: 'SF-A' }),
      );
    });

    it('mirror still fires when writeStatus is rejected (carve-out / downgrade)', async () => {
      // Lead is already completed; SF says scheduled. writeStatus rejects as
      // pipeline_downgrade — but the mirror should still record SF's view.
      const { prisma } = buildPrisma({
        leads: { 'L1': { id: 'L1', userId: 'U1', status: 'completed', sfJobId: null, syncStatus: 'pending' } },
      });
      const ls = buildLeadStatus(false); // writeStatus.applied=false
      const svc = new SfHistoricalSyncService(prisma, ls);
      await svc.applyBulkLink({
        rows: [{
          lb_lead_id: 'L1', sf_job_id: 'SF-A', confidence: 'exact',
          match_basis: 'externalRequestId', sf_status: 'scheduled',
        }],
      });
      expect(ls.writeSfJobOutcomeMirror).toHaveBeenCalled();
    });

    it('mirror NOT called when no sf_status/sf_payment_status supplied', async () => {
      const { prisma } = buildPrisma({
        leads: { 'L1': { id: 'L1', userId: 'U1', status: 'new', sfJobId: null, syncStatus: 'pending' } },
      });
      const ls = buildLeadStatus(true);
      const svc = new SfHistoricalSyncService(prisma, ls);
      await svc.applyBulkLink({
        rows: [{ lb_lead_id: 'L1', sf_job_id: 'SF-A', confidence: 'exact', match_basis: 'externalRequestId' }],
      });
      expect(ls.writeSfJobOutcomeMirror).not.toHaveBeenCalled();
      expect(ls.writeStatus).not.toHaveBeenCalled();
    });

    it('mirror NOT called when sfStatus maps to null (unmappable)', async () => {
      const { prisma } = buildPrisma({
        leads: { 'L1': { id: 'L1', userId: 'U1', status: 'new', sfJobId: null, syncStatus: 'pending' } },
      });
      const ls = buildLeadStatus(true);
      const svc = new SfHistoricalSyncService(prisma, ls);
      await svc.manualLink('admin-1', { lbLeadId: 'L1', sfJobId: 'SF-A', sfStatus: 'on_hold' });
      expect(ls.writeSfJobOutcomeMirror).not.toHaveBeenCalled();
    });

    it('repeated apply of same event is idempotent on the mirror via stale-protection in the helper', async () => {
      // The helper itself owns stale-protection (sfJobOutcomeAt < occurredAt
      // gate at the SQL level). Historical sync calls it with the same
      // occurredAt on every replay of the same sourceEventId — so a second
      // call with the same timestamp returns written=false. We verify by
      // calling applyBulkLink twice with the same row.
      const { prisma } = buildPrisma({
        leads: { 'L1': { id: 'L1', userId: 'U1', status: 'new', sfJobId: null, syncStatus: 'pending' } },
      });
      const ls = buildLeadStatus(true);
      (ls.writeSfJobOutcomeMirror as jest.Mock)
        .mockResolvedValueOnce({ written: true })
        .mockResolvedValueOnce({ written: false }); // stale guard short-circuits second call
      const svc = new SfHistoricalSyncService(prisma, ls);
      const occurredAt = new Date('2026-05-25T17:30:19Z').toISOString();
      const row = {
        lb_lead_id: 'L1', sf_job_id: 'SF-A', confidence: 'exact' as const,
        match_basis: 'externalRequestId' as const,
        sf_status: 'scheduled', occurred_at: occurredAt,
      };
      await svc.applyBulkLink({ rows: [row] });
      await svc.applyBulkLink({ rows: [row] });
      expect(ls.writeSfJobOutcomeMirror).toHaveBeenCalledTimes(2);
      // First written=true, second written=false — verifies the helper's
      // return value is the source of truth for "did the mirror update?"
    });
  });

  // Regression: an existing tenant connected before historical-sync deployed
  // has every lead at syncStatus=null. The 'pending' filter must include
  // those null rows so SF can pull candidates immediately, without waiting
  // for the connection-time enumeration to be triggered manually.
  describe('candidates filter — null is treated as pending; other filters stay exact', () => {
    function corpus() {
      return {
        leads: {
          'L_NULL_A':   { id: 'L_NULL_A',   userId: 'U1', platform: 'thumbtack', externalRequestId: 'r1', customerName: 'Erin',   status: 'scheduled', syncStatus: null,           sfJobId: null, createdAt: new Date() },
          'L_NULL_B':   { id: 'L_NULL_B',   userId: 'U1', platform: 'thumbtack', externalRequestId: 'r2', customerName: 'Casey',  status: 'scheduled', syncStatus: null,           sfJobId: null, createdAt: new Date() },
          'L_PENDING':  { id: 'L_PENDING',  userId: 'U1', platform: 'thumbtack', externalRequestId: 'r3', customerName: 'Oriana', status: 'contacted', syncStatus: 'pending',      sfJobId: null, createdAt: new Date() },
          'L_LINKED':   { id: 'L_LINKED',   userId: 'U1', platform: 'thumbtack', externalRequestId: 'r4', customerName: 'Derek',  status: 'completed', syncStatus: 'linked',       sfJobId: 'SF-1', createdAt: new Date() },
          'L_REVIEW':   { id: 'L_REVIEW',   userId: 'U1', platform: 'thumbtack', externalRequestId: 'r5', customerName: 'Allyssa', status: 'scheduled', syncStatus: 'needs_review', sfJobId: null, createdAt: new Date() },
          'L_NOMATCH':  { id: 'L_NOMATCH',  userId: 'U1', platform: 'thumbtack', externalRequestId: 'r6', customerName: 'Smith',   status: 'new',       syncStatus: 'no_match',     sfJobId: null, createdAt: new Date() },
          'L_FAILED':   { id: 'L_FAILED',   userId: 'U1', platform: 'thumbtack', externalRequestId: 'r7', customerName: 'Jones',   status: 'engaged',   syncStatus: 'failed',       sfJobId: null, createdAt: new Date() },
          'L_SKIPPED':  { id: 'L_SKIPPED',  userId: 'U1', platform: 'thumbtack', externalRequestId: 'r8', customerName: 'Lost',    status: 'lost',      syncStatus: 'skipped',      sfJobId: null, createdAt: new Date() },
        },
      };
    }

    it("'pending' filter returns BOTH syncStatus='pending' AND syncStatus IS NULL", async () => {
      const { prisma } = buildPrisma(corpus());
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const rows = await svc.candidates('U1', { syncStatus: 'pending' as any });
      const ids = rows.map((r) => r.leadId).sort();
      expect(ids).toEqual(['L_NULL_A', 'L_NULL_B', 'L_PENDING'].sort());
    });

    it("'linked' filter is exact — only linked rows", async () => {
      const { prisma } = buildPrisma(corpus());
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const rows = await svc.candidates('U1', { syncStatus: 'linked' as any });
      expect(rows.map((r) => r.leadId)).toEqual(['L_LINKED']);
    });

    it("'needs_review' filter is exact", async () => {
      const { prisma } = buildPrisma(corpus());
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const rows = await svc.candidates('U1', { syncStatus: 'needs_review' as any });
      expect(rows.map((r) => r.leadId)).toEqual(['L_REVIEW']);
    });

    it("'no_match' filter is exact", async () => {
      const { prisma } = buildPrisma(corpus());
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const rows = await svc.candidates('U1', { syncStatus: 'no_match' as any });
      expect(rows.map((r) => r.leadId)).toEqual(['L_NOMATCH']);
    });

    it("'failed' filter is exact", async () => {
      const { prisma } = buildPrisma(corpus());
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const rows = await svc.candidates('U1', { syncStatus: 'failed' as any });
      expect(rows.map((r) => r.leadId)).toEqual(['L_FAILED']);
    });

    it("'skipped' filter is exact — does NOT leak null rows", async () => {
      const { prisma } = buildPrisma(corpus());
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const rows = await svc.candidates('U1', { syncStatus: 'skipped' as any });
      expect(rows.map((r) => r.leadId)).toEqual(['L_SKIPPED']);
    });

    it("syncStatus=null filter returns only null rows", async () => {
      const { prisma } = buildPrisma(corpus());
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const rows = await svc.candidates('U1', { syncStatus: null });
      expect(rows.map((r) => r.leadId).sort()).toEqual(['L_NULL_A', 'L_NULL_B'].sort());
    });

    it('default (no filter) returns pending|needs_review|failed|no_match + null, excludes linked + skipped', async () => {
      const { prisma } = buildPrisma(corpus());
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const rows = await svc.candidates('U1', {});
      const ids = rows.map((r) => r.leadId).sort();
      expect(ids).toEqual(['L_FAILED', 'L_NOMATCH', 'L_NULL_A', 'L_NULL_B', 'L_PENDING', 'L_REVIEW'].sort());
      expect(ids).not.toContain('L_LINKED');
      expect(ids).not.toContain('L_SKIPPED');
    });

    // PR B (2026-06-04): lead_linked rows have already received a verdict
    // from SF and must NOT be re-presented to SF on the next candidate pull
    // (otherwise SF would re-emit the same lead_only verdict each cycle,
    // wasting roundtrips for no behavioral effect).
    it("default (no filter) excludes syncStatus='lead_linked' (SF already issued a verdict; matcher-exclusion)", async () => {
      const c = corpus();
      // Add a lead_linked row to the corpus
      (c.leads as any)['L_LEADLINKED'] = {
        id: 'L_LEADLINKED', userId: 'U1', platform: 'thumbtack',
        externalRequestId: 'r-ll', customerName: 'SfLeadOnly',
        status: 'completed', syncStatus: 'lead_linked', sfJobId: null,
        createdAt: new Date(),
      };
      const { prisma } = buildPrisma(c);
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const rows = await svc.candidates('U1', {});
      const ids = rows.map((r) => r.leadId);
      expect(ids).not.toContain('L_LEADLINKED');
      // Explicit-filter request still works (operator dashboard can list them)
      const explicit = await svc.candidates('U1', { syncStatus: 'lead_linked' as any });
      expect(explicit.map((r) => r.leadId)).toEqual(['L_LEADLINKED']);
    });

    it("opts.status filter narrows to that LB canonical status only (Erin-shape: status='scheduled')", async () => {
      const { prisma } = buildPrisma({
        leads: {
          'ERIN':       { id: 'ERIN',       userId: 'U1', status: 'scheduled', syncStatus: null,      sfJobId: null, customerName: 'Erin',   externalRequestId: 'ext-erin', platform: 'thumbtack', createdAt: new Date() },
          'OTHER_NEW':  { id: 'OTHER_NEW',  userId: 'U1', status: 'new',       syncStatus: 'pending', sfJobId: null, customerName: 'Other',  externalRequestId: 'ext-2',    platform: 'thumbtack', createdAt: new Date() },
          'OTHER_LOST': { id: 'OTHER_LOST', userId: 'U1', status: 'lost',      syncStatus: null,      sfJobId: null, customerName: 'Lost',   externalRequestId: 'ext-3',    platform: 'thumbtack', createdAt: new Date() },
          'OTHER_SCHED':{ id: 'OTHER_SCHED',userId: 'U1', status: 'scheduled', syncStatus: 'pending', sfJobId: null, customerName: 'OtherSched', externalRequestId: 'ext-4', platform: 'thumbtack', createdAt: new Date() },
        },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const rows = await svc.candidates('U1', { syncStatus: 'pending' as any, status: 'scheduled' });
      const ids = rows.map((r) => r.leadId).sort();
      // Only the 2 scheduled rows (one with syncStatus=null, one with 'pending').
      expect(ids).toEqual(['ERIN', 'OTHER_SCHED']);
      // The 'new' (other syncStatus=pending) and 'lost' (other null) rows are
      // excluded by the status filter.
    });
  });

  describe('dashboard', () => {
    it('aggregates counts, stale buckets, and match-key availability', async () => {
      const old = new Date(Date.now() - 30 * 86400_000).toISOString();
      const fresh = new Date().toISOString();
      const { prisma } = buildPrisma({
        sfConnection: { 'U1': { sfTenantId: '2' } },
        leads: {
          'L1': { id: 'L1', userId: 'U1', status: 'scheduled', syncStatus: 'pending', sfJobId: null, customerPhone: '8135551234', customerEmail: null, externalRequestId: 'r1', statusUpdatedAt: new Date(old) },
          'L2': { id: 'L2', userId: 'U1', status: 'booked',    syncStatus: 'pending', sfJobId: null, customerPhone: '8135551235', customerEmail: 'x@y', externalRequestId: 'r2', statusUpdatedAt: new Date(old) },
          'L3': { id: 'L3', userId: 'U1', status: 'completed', syncStatus: 'linked',  sfJobId: 'SF-A', customerPhone: null, customerEmail: null, externalRequestId: 'r3', statusUpdatedAt: new Date(fresh) },
          'L4': { id: 'L4', userId: 'U1', status: 'lost',      syncStatus: 'skipped', sfJobId: null, customerPhone: null, customerEmail: null, externalRequestId: 'r4', statusUpdatedAt: new Date(fresh) },
        },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const d = await svc.dashboard('U1');
      expect(d.sfTenantId).toBe('2');
      expect(d.totalLeads).toBe(4);
      expect(d.byStatus.scheduled).toBe(1);
      expect(d.bySyncStatus.pending).toBe(2);
      expect(d.bySyncStatus.linked).toBe(1);
      expect(d.bySyncStatus.skipped).toBe(1);
      expect(d.staleScheduled).toBe(1);  // L1
      expect(d.staleBooked).toBe(1);     // L2
      expect(d.unsyncedActionable).toBe(2);
      expect(d.matchKeysAvailable.withPhone).toBe(2);
      expect(d.matchKeysAvailable.withEmail).toBe(1);
      expect(d.matchKeysAvailable.withExternalRequestId).toBe(4);
    });
  });
});
