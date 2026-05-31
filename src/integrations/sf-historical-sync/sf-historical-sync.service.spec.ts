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
  } as any;
}

describe('SfHistoricalSyncService', () => {
  describe('enumeration (connection-time + trigger)', () => {
    it('marks actionable leads as pending, terminal as skipped, leaves linked alone', async () => {
      const { prisma, leads, updates } = buildPrisma({
        leads: {
          'L1': { id: 'L1', userId: 'U1', status: 'scheduled', sfJobId: null, syncStatus: null },
          'L2': { id: 'L2', userId: 'U1', status: 'lost', sfJobId: null, syncStatus: null },
          'L3': { id: 'L3', userId: 'U1', status: 'completed', sfJobId: 'SF-111', syncStatus: null },
          'L4': { id: 'L4', userId: 'U1', status: 'cancelled', sfJobId: null, syncStatus: null },
          'L5': { id: 'L5', userId: 'U1', status: 'contacted', sfJobId: null, syncStatus: null },
        },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.enumerateOnConnect('U1');
      expect(r.scanned).toBe(5);
      expect(r.markedPending).toBe(2);   // L1 scheduled, L5 contacted
      expect(r.markedSkipped).toBe(2);   // L2 lost, L4 cancelled
      expect(r.alreadyLinked).toBe(1);   // L3 (had sfJobId)
      expect(leads.get('L1').syncStatus).toBe('pending');
      expect(leads.get('L2').syncStatus).toBe('skipped');
      expect(leads.get('L3').syncStatus).toBe('linked');  // backfilled from sfJobId
      expect(leads.get('L4').syncStatus).toBe('skipped');
      expect(leads.get('L5').syncStatus).toBe('pending');
    });

    it('idempotent: re-running does not churn already-pending rows', async () => {
      const { prisma } = buildPrisma({
        leads: {
          'L1': { id: 'L1', userId: 'U1', status: 'scheduled', sfJobId: null, syncStatus: 'pending' },
          'L2': { id: 'L2', userId: 'U1', status: 'lost', sfJobId: null, syncStatus: 'skipped' },
          'L3': { id: 'L3', userId: 'U1', status: 'completed', sfJobId: 'SF-A', syncStatus: 'linked' },
        },
      });
      const svc = new SfHistoricalSyncService(prisma, buildLeadStatus());
      const r = await svc.enumerateOnConnect('U1');
      expect(r.markedPending).toBe(0);   // L1 already pending
      expect(r.markedSkipped).toBe(0);   // L2 already skipped
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
