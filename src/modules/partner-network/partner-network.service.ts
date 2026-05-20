/**
 * Partner Network Service
 *
 * Self-contained business logic for the Partner Network Beta MVP. All data
 * lives in `partner_*` tables — this module intentionally has no reach into
 * the marketplace Lead model so it can be extracted into a standalone product
 * later without untangling joins.
 *
 * Tenant boundary: every read/write filters by workspaceId. workspaceId is
 * the LeadBridge user.id for now; later this becomes the org id when partner
 * network goes multi-user-per-tenant.
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/utils/prisma.service';
import {
  PartnerBusiness,
  PartnerLead,
  PartnerLeadIntent,
  PartnerLeadStatus,
  PartnerReferralCode,
  PartnerRelationship,
  Prisma,
} from '../../../generated/prisma';
import { CreatePartnerBusinessDto, UpdatePartnerBusinessDto } from './dto/business.dto';
import {
  CreatePartnerRelationshipDto,
  UpdatePartnerRelationshipDto,
} from './dto/relationship.dto';
import {
  CreatePartnerReferralCodeDto,
  UpdatePartnerReferralCodeDto,
} from './dto/referral-code.dto';
import { SubmitPartnerLeadDto, UpdatePartnerLeadDto } from './dto/lead.dto';

// Intent → estimated value table. Hardcoded for MVP per spec. When this
// becomes configurable per-relationship, the table moves to PartnerRelationship
// and resolveEstimatedValue() takes the relationship id.
const INTENT_VALUE: Record<PartnerLeadIntent, number> = {
  this_week: 30,
  this_month: 20,
  not_sure: 10,
};

// Duplicate detection window: a lead with the same phone for the same
// destination within this many days flags possibleDuplicate=true.
const DUPLICATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface PublicReferralView {
  code: string;
  destinationBusinessName: string;
  offerText: string | null;
  active: boolean;
}

@Injectable()
export class PartnerNetworkService {
  private readonly logger = new Logger(PartnerNetworkService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ============================================================
  // Businesses
  // ============================================================

  async listBusinesses(workspaceId: string): Promise<PartnerBusiness[]> {
    return this.prisma.partnerBusiness.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getBusiness(workspaceId: string, id: string): Promise<PartnerBusiness> {
    const business = await this.prisma.partnerBusiness.findFirst({
      where: { id, workspaceId },
    });
    if (!business) throw new NotFoundException('Business not found');
    return business;
  }

  async createBusiness(
    workspaceId: string,
    dto: CreatePartnerBusinessDto,
  ): Promise<PartnerBusiness> {
    return this.prisma.partnerBusiness.create({
      data: {
        workspaceId,
        name: dto.name.trim(),
        category: dto.category?.trim() || null,
        phone: dto.phone?.trim() || null,
        website: dto.website?.trim() || null,
        serviceArea: dto.serviceArea?.trim() || null,
      },
    });
  }

  async updateBusiness(
    workspaceId: string,
    id: string,
    dto: UpdatePartnerBusinessDto,
  ): Promise<PartnerBusiness> {
    await this.getBusiness(workspaceId, id);
    return this.prisma.partnerBusiness.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.category !== undefined && { category: dto.category?.trim() || null }),
        ...(dto.phone !== undefined && { phone: dto.phone?.trim() || null }),
        ...(dto.website !== undefined && { website: dto.website?.trim() || null }),
        ...(dto.serviceArea !== undefined && { serviceArea: dto.serviceArea?.trim() || null }),
        ...(dto.active !== undefined && { active: dto.active }),
      },
    });
  }

  // ============================================================
  // Relationships
  // ============================================================

  async listRelationships(workspaceId: string): Promise<
    Array<PartnerRelationship & {
      sourceBusiness: PartnerBusiness;
      destinationBusiness: PartnerBusiness;
    }>
  > {
    return this.prisma.partnerRelationship.findMany({
      where: { workspaceId },
      include: { sourceBusiness: true, destinationBusiness: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createRelationship(
    workspaceId: string,
    dto: CreatePartnerRelationshipDto,
  ): Promise<PartnerRelationship> {
    if (dto.sourceBusinessId === dto.destinationBusinessId) {
      throw new BadRequestException('Source and destination must be different businesses');
    }
    // Verify both businesses belong to this workspace before linking — keeps
    // tenant isolation even if a client tries to point at someone else's row.
    await Promise.all([
      this.getBusiness(workspaceId, dto.sourceBusinessId),
      this.getBusiness(workspaceId, dto.destinationBusinessId),
    ]);
    return this.prisma.partnerRelationship.create({
      data: {
        workspaceId,
        sourceBusinessId: dto.sourceBusinessId,
        destinationBusinessId: dto.destinationBusinessId,
        name: dto.name?.trim() || null,
        defaultOfferText: dto.defaultOfferText?.trim() || null,
        notes: dto.notes?.trim() || null,
      },
    });
  }

  async updateRelationship(
    workspaceId: string,
    id: string,
    dto: UpdatePartnerRelationshipDto,
  ): Promise<PartnerRelationship> {
    const existing = await this.prisma.partnerRelationship.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) throw new NotFoundException('Relationship not found');
    return this.prisma.partnerRelationship.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name?.trim() || null }),
        ...(dto.active !== undefined && { active: dto.active }),
        ...(dto.defaultOfferText !== undefined && {
          defaultOfferText: dto.defaultOfferText?.trim() || null,
        }),
        ...(dto.notes !== undefined && { notes: dto.notes?.trim() || null }),
      },
    });
  }

  // ============================================================
  // Referral codes
  // ============================================================

  async listReferralCodes(workspaceId: string): Promise<
    Array<PartnerReferralCode & {
      sourceBusiness: PartnerBusiness;
      destinationBusiness: PartnerBusiness;
    }>
  > {
    return this.prisma.partnerReferralCode.findMany({
      where: { workspaceId },
      include: { sourceBusiness: true, destinationBusiness: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createReferralCode(
    workspaceId: string,
    dto: CreatePartnerReferralCodeDto,
  ): Promise<PartnerReferralCode> {
    const code = dto.code.trim().toUpperCase();
    await Promise.all([
      this.getBusiness(workspaceId, dto.sourceBusinessId),
      this.getBusiness(workspaceId, dto.destinationBusinessId),
    ]);
    if (dto.partnerRelationshipId) {
      const rel = await this.prisma.partnerRelationship.findFirst({
        where: { id: dto.partnerRelationshipId, workspaceId },
      });
      if (!rel) throw new BadRequestException('partnerRelationshipId is invalid for this workspace');
    }
    const existing = await this.prisma.partnerReferralCode.findUnique({ where: { code } });
    if (existing) {
      throw new BadRequestException(`Referral code "${code}" is already in use`);
    }
    return this.prisma.partnerReferralCode.create({
      data: {
        workspaceId,
        code,
        sourceBusinessId: dto.sourceBusinessId,
        destinationBusinessId: dto.destinationBusinessId,
        partnerRelationshipId: dto.partnerRelationshipId ?? null,
        employeeName: dto.employeeName?.trim() || null,
        publicUrl: `/r/${code}`,
      },
    });
  }

  async updateReferralCode(
    workspaceId: string,
    id: string,
    dto: UpdatePartnerReferralCodeDto,
  ): Promise<PartnerReferralCode> {
    const existing = await this.prisma.partnerReferralCode.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) throw new NotFoundException('Referral code not found');
    return this.prisma.partnerReferralCode.update({
      where: { id },
      data: {
        ...(dto.active !== undefined && { active: dto.active }),
        ...(dto.employeeName !== undefined && {
          employeeName: dto.employeeName?.trim() || null,
        }),
      },
    });
  }

  // ============================================================
  // Public referral flow (no auth)
  // ============================================================

  /**
   * Resolve a public referral code to the bare info the customer-facing form
   * needs. Always 404 for missing or inactive codes — we don't leak that an
   * inactive code "used to exist".
   */
  async getPublicReferralView(code: string): Promise<PublicReferralView> {
    const normalized = code.trim().toUpperCase();
    const referral = await this.prisma.partnerReferralCode.findUnique({
      where: { code: normalized },
      include: {
        destinationBusiness: true,
        partnerRelationship: true,
      },
    });
    if (!referral || !referral.active || !referral.destinationBusiness.active) {
      throw new NotFoundException('Referral code not found');
    }
    const offerText =
      referral.partnerRelationship?.defaultOfferText ?? null;
    return {
      code: referral.code,
      destinationBusinessName: referral.destinationBusiness.name,
      offerText,
      active: true,
    };
  }

  /**
   * Submit a public lead via a referral code. Source/destination/workspace
   * are resolved server-side from the code — client-provided IDs are ignored.
   *
   * Duplicate flag (not a block): if any lead with the same phone exists for
   * the same destination within DUPLICATE_WINDOW_MS, mark possibleDuplicate.
   */
  async submitPublicLead(code: string, dto: SubmitPartnerLeadDto): Promise<PartnerLead> {
    const normalized = code.trim().toUpperCase();
    const referral = await this.prisma.partnerReferralCode.findUnique({
      where: { code: normalized },
      include: { destinationBusiness: true },
    });
    if (!referral || !referral.active || !referral.destinationBusiness.active) {
      throw new NotFoundException('Referral code not found');
    }
    const phone = dto.customerPhone.trim();
    const name = dto.customerName.trim();
    if (!name) throw new BadRequestException('customerName is required');
    if (!phone) throw new BadRequestException('customerPhone is required');

    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS);
    const dupCount = await this.prisma.partnerLead.count({
      where: {
        destinationBusinessId: referral.destinationBusinessId,
        customerPhone: phone,
        createdAt: { gte: since },
      },
    });

    const estimatedValue = INTENT_VALUE[dto.intentTiming];

    const lead = await this.prisma.partnerLead.create({
      data: {
        workspaceId: referral.workspaceId,
        referralCodeId: referral.id,
        sourceBusinessId: referral.sourceBusinessId,
        destinationBusinessId: referral.destinationBusinessId,
        customerName: name,
        customerPhone: phone,
        notes: dto.notes?.trim() || null,
        intentTiming: dto.intentTiming,
        estimatedValue,
        status: PartnerLeadStatus.new,
        possibleDuplicate: dupCount > 0,
        utmSource: dto.utmSource?.trim() || null,
        utmMedium: dto.utmMedium?.trim() || null,
        utmCampaign: dto.utmCampaign?.trim() || null,
      },
    });
    this.logger.log(
      `[partner-network] lead submitted code=${referral.code} ` +
        `dst=${referral.destinationBusinessId} value=${estimatedValue} ` +
        `dup=${lead.possibleDuplicate}`,
    );
    return lead;
  }

  // ============================================================
  // Admin leads
  // ============================================================

  async listLeads(
    workspaceId: string,
    filters: {
      sourceBusinessId?: string;
      destinationBusinessId?: string;
      referralCodeId?: string;
      status?: PartnerLeadStatus;
      intentTiming?: PartnerLeadIntent;
    },
  ) {
    const where: Prisma.PartnerLeadWhereInput = {
      workspaceId,
      ...(filters.sourceBusinessId && { sourceBusinessId: filters.sourceBusinessId }),
      ...(filters.destinationBusinessId && {
        destinationBusinessId: filters.destinationBusinessId,
      }),
      ...(filters.referralCodeId && { referralCodeId: filters.referralCodeId }),
      ...(filters.status && { status: filters.status }),
      ...(filters.intentTiming && { intentTiming: filters.intentTiming }),
    };
    return this.prisma.partnerLead.findMany({
      where,
      include: {
        referralCode: true,
        sourceBusiness: true,
        destinationBusiness: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateLead(
    workspaceId: string,
    id: string,
    dto: UpdatePartnerLeadDto,
  ): Promise<PartnerLead> {
    const existing = await this.prisma.partnerLead.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('Lead not found');
    return this.prisma.partnerLead.update({
      where: { id },
      data: {
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.notes !== undefined && { notes: dto.notes?.trim() || null }),
      },
    });
  }

  // ============================================================
  // Dashboard
  // ============================================================

  /**
   * Aggregate dashboard metrics. Intent→tier mapping:
   *   hot  = this_week
   *   warm = this_month
   *   cold = not_sure
   */
  async getDashboard(workspaceId: string) {
    const leads = await this.prisma.partnerLead.findMany({
      where: { workspaceId },
      include: { referralCode: true, sourceBusiness: true, destinationBusiness: true },
    });

    const total = leads.length;
    const hot = leads.filter(l => l.intentTiming === 'this_week').length;
    const warm = leads.filter(l => l.intentTiming === 'this_month').length;
    const cold = leads.filter(l => l.intentTiming === 'not_sure').length;
    const estimatedTotalValue = leads.reduce((acc, l) => acc + (l.estimatedValue ?? 0), 0);

    const bySource = new Map<string, { businessId: string; businessName: string; count: number; value: number }>();
    const byCode = new Map<string, { codeId: string; code: string; employeeName: string | null; count: number; value: number }>();
    const byStatus = new Map<PartnerLeadStatus, number>();

    for (const lead of leads) {
      const srcKey = lead.sourceBusinessId;
      const src = bySource.get(srcKey) ?? {
        businessId: lead.sourceBusinessId,
        businessName: lead.sourceBusiness.name,
        count: 0,
        value: 0,
      };
      src.count += 1;
      src.value += lead.estimatedValue;
      bySource.set(srcKey, src);

      const codeKey = lead.referralCodeId;
      const code = byCode.get(codeKey) ?? {
        codeId: lead.referralCodeId,
        code: lead.referralCode.code,
        employeeName: lead.referralCode.employeeName ?? null,
        count: 0,
        value: 0,
      };
      code.count += 1;
      code.value += lead.estimatedValue;
      byCode.set(codeKey, code);

      byStatus.set(lead.status, (byStatus.get(lead.status) ?? 0) + 1);
    }

    return {
      totals: { total, hot, warm, cold, estimatedTotalValue },
      bySourceBusiness: Array.from(bySource.values()).sort((a, b) => b.count - a.count),
      byReferralCode: Array.from(byCode.values()).sort((a, b) => b.count - a.count),
      byStatus: Object.fromEntries(byStatus),
    };
  }

  // ============================================================
  // CSV export
  // ============================================================

  /**
   * Render the partner-lead list as CSV. Caller writes Content-Type +
   * Content-Disposition headers; this method only builds the body.
   */
  async exportLeadsCsv(workspaceId: string): Promise<string> {
    const leads = await this.listLeads(workspaceId, {});
    const header = [
      'id',
      'createdAt',
      'sourceBusiness',
      'destinationBusiness',
      'referralCode',
      'employeeName',
      'customerName',
      'customerPhone',
      'intentTiming',
      'estimatedValue',
      'status',
      'possibleDuplicate',
      'notes',
    ];
    const rows = leads.map(l => [
      l.id,
      l.createdAt.toISOString(),
      l.sourceBusiness.name,
      l.destinationBusiness.name,
      l.referralCode.code,
      l.referralCode.employeeName ?? '',
      l.customerName,
      l.customerPhone,
      l.intentTiming,
      String(l.estimatedValue),
      l.status,
      l.possibleDuplicate ? 'yes' : 'no',
      l.notes ?? '',
    ]);
    return [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
  }

  // Internal: workspace-membership check used by controllers that take an
  // arbitrary admin-supplied ID. Throws ForbiddenException if the row exists
  // but belongs to a different workspace; throws NotFound if the row doesn't
  // exist at all. Keeping these distinct helps the UI distinguish "deleted"
  // from "wrong tenant" without leaking row existence.
  // (Not used yet — keep for future cross-cutting checks.)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private _ensureMine(workspaceId: string, rowWorkspaceId: string | null | undefined): void {
    if (!rowWorkspaceId) throw new NotFoundException();
    if (rowWorkspaceId !== workspaceId) throw new ForbiddenException();
  }
}

// Quote a CSV cell — escapes commas, quotes, newlines per RFC 4180.
function csvCell(v: string): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
