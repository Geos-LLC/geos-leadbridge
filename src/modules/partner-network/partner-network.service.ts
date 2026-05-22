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
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PrismaService } from '../../common/utils/prisma.service';
import { normalizePhoneE164 } from './utils/phone.util';
import { normalizeWebsiteUrl, verifyWebsite, VerifyWebsiteResult } from './utils/website-verify';
import {
  PartnerBusiness,
  PartnerLead,
  PartnerLeadContactPref,
  PartnerLeadEventType,
  PartnerLeadIntent,
  PartnerLeadStatus,
  PartnerReferralCode,
  PartnerRelationship,
  Prisma,
} from '../../../generated/prisma';
import {
  CreatePartnerBusinessDto,
  PartnerBusinessWebsiteMetadata,
  UpdatePartnerBusinessDto,
} from './dto/business.dto';
import {
  CreatePartnerRelationshipDto,
  SuggestRelationshipCopyDto,
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
  future_interest: 10,
  not_sure: 10,
};

/**
 * Public helper exported so other modules / tests can mirror the MVP value
 * table without poking at the constant directly. When intent value becomes
 * per-relationship, swap the body for a DB lookup — callers stay unchanged.
 */
export function calculateEstimatedLeadValue(intent: PartnerLeadIntent): number {
  return INTENT_VALUE[intent];
}

// External QR image service used for MVP — no qrcode dependency. Swap to a
// self-hosted PNG path when we want to stop depending on an external service.
const QR_IMAGE_BASE = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=';

function buildQrUrl(code: string): string {
  return `${QR_IMAGE_BASE}${encodeURIComponent(`/r/${code}`)}`;
}

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
  private _openai: OpenAI | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // Lazy OpenAI client — matches the pattern used by IntentClassifierService.
  // Keeps the module self-contained for future extraction: no dependency on
  // LeadBridge's AiService / module wiring beyond ConfigService.
  private get openai(): OpenAI {
    if (!this._openai) {
      const apiKey = this.config.get<string>('OPENAI_API_KEY');
      if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
      this._openai = new OpenAI({ apiKey });
    }
    return this._openai;
  }

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
        phone: this.normalizePhoneField(dto.phone),
        website: this.normalizeWebsiteField(dto.website),
        websiteMetadataJson: this.serializeMetadata(dto.websiteMetadata),
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
    // If the website is being cleared, drop the cached metadata along with
    // it — stale title/description for a different (or no) site would
    // mislead the AI suggester.
    const websiteBeingCleared =
      dto.website !== undefined && (this.normalizeWebsiteField(dto.website) ?? null) === null;
    return this.prisma.partnerBusiness.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.category !== undefined && { category: dto.category?.trim() || null }),
        ...(dto.phone !== undefined && { phone: this.normalizePhoneField(dto.phone) }),
        ...(dto.website !== undefined && { website: this.normalizeWebsiteField(dto.website) }),
        ...(dto.websiteMetadata !== undefined && {
          websiteMetadataJson: this.serializeMetadata(dto.websiteMetadata),
        }),
        ...(websiteBeingCleared && { websiteMetadataJson: null }),
        ...(dto.serviceArea !== undefined && { serviceArea: dto.serviceArea?.trim() || null }),
        ...(dto.active !== undefined && { active: dto.active }),
      },
    });
  }

  // Coerce a client-provided metadata object to the canonical shape and JSON
  // string. Drops unknown keys + caps each field length so a hostile or
  // verbose verify response can't bloat the DB row.
  private serializeMetadata(
    input: PartnerBusinessWebsiteMetadata | null | undefined,
  ): string | null {
    if (!input || typeof input !== 'object') return null;
    const trim = (v: unknown, max: number): string | undefined => {
      if (typeof v !== 'string') return undefined;
      const s = v.trim();
      return s ? s.slice(0, max) : undefined;
    };
    const shaped: PartnerBusinessWebsiteMetadata = {
      title: trim(input.title, 200),
      description: trim(input.description, 500),
      phone: trim(input.phone, 40),
    };
    if (!shaped.title && !shaped.description && !shaped.phone) return null;
    return JSON.stringify(shaped);
  }

  private parseMetadata(json: string | null | undefined): PartnerBusinessWebsiteMetadata | null {
    if (!json) return null;
    try {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed as PartnerBusinessWebsiteMetadata;
    } catch {
      return null;
    }
  }

  // Normalize phone for storage. Returns null for empty input; throws on a
  // non-empty input that doesn't yield ≥10 digits, so a typo can't sit on a
  // business record silently. Matches the User.businessPhone convention
  // (E.164, "+1XXXXXXXXXX") so partner-network numbers can later be SMS'd
  // through Sigcore without an extra format step.
  private normalizePhoneField(input: string | null | undefined): string | null {
    const trimmed = (input ?? '').trim();
    if (trimmed.length === 0) return null;
    const normalized = normalizePhoneE164(trimmed);
    if (!normalized) {
      throw new BadRequestException(
        `phone "${trimmed}" must contain at least 10 digits`,
      );
    }
    return normalized;
  }

  // Live website check used by the Verify button on the business form.
  // Wraps the in-module verifier so callers don't have to import the util
  // directly. Result mirrors UsersService.verifyWebsite (same field names)
  // for an easy admin-UI swap — but the implementation is fully isolated
  // to this module: nothing under src/users is reached.
  async verifyBusinessWebsite(input: string): Promise<VerifyWebsiteResult> {
    return verifyWebsite(input ?? '');
  }

  // Normalize website for storage. Returns null for empty input; throws on a
  // non-empty input that fails URL parsing or hits the SSRF guard. Live
  // reachability check is verifyBusinessWebsite — the partner-network UI
  // calls that endpoint separately before save.
  private normalizeWebsiteField(input: string | null | undefined): string | null {
    const trimmed = (input ?? '').trim();
    if (trimmed.length === 0) return null;
    const normalized = normalizeWebsiteUrl(trimmed);
    if (!normalized) {
      throw new BadRequestException(
        `website "${trimmed}" is not a valid URL`,
      );
    }
    return normalized;
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
        widgetEnabled: dto.widgetEnabled ?? false,
        widgetType: dto.widgetType?.trim() || null,
        popupDelayMs: dto.popupDelayMs ?? null,
        autoOpenFromReferral: dto.autoOpenFromReferral ?? false,
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
        ...(dto.widgetEnabled !== undefined && { widgetEnabled: dto.widgetEnabled }),
        ...(dto.widgetType !== undefined && { widgetType: dto.widgetType?.trim() || null }),
        ...(dto.popupDelayMs !== undefined && {
          popupDelayMs: dto.popupDelayMs == null ? null : dto.popupDelayMs,
        }),
        ...(dto.autoOpenFromReferral !== undefined && {
          autoOpenFromReferral: dto.autoOpenFromReferral,
        }),
      },
    });
  }

  // ============================================================
  // AI relationship-copy suggester
  // ============================================================

  /**
   * Generate a partnership Name + Default Offer Text suggestion for the admin
   * to accept/edit. Grounds the model in the two businesses' names,
   * categories, service areas, and cached website metadata (title +
   * description) when available. Falls back gracefully when sites haven't
   * been Verified yet — output quality just drops to "generic but on-topic".
   *
   * Returns plain strings (NOT auto-saved). The admin reviews them in the
   * relationship form, edits, and clicks Save like any other field.
   */
  async suggestRelationshipCopy(
    workspaceId: string,
    dto: SuggestRelationshipCopyDto,
  ): Promise<{ name: string; offerText: string; usedMetadata: boolean }> {
    if (dto.sourceBusinessId === dto.destinationBusinessId) {
      throw new BadRequestException('Source and destination must be different businesses');
    }
    const [source, destination] = await Promise.all([
      this.getBusiness(workspaceId, dto.sourceBusinessId),
      this.getBusiness(workspaceId, dto.destinationBusinessId),
    ]);

    const srcMeta = this.parseMetadata(source.websiteMetadataJson);
    const dstMeta = this.parseMetadata(destination.websiteMetadataJson);
    const usedMetadata = !!(srcMeta || dstMeta);

    const describe = (
      label: 'SOURCE' | 'DESTINATION',
      b: PartnerBusiness,
      meta: PartnerBusinessWebsiteMetadata | null,
    ): string => {
      const lines: string[] = [`${label} BUSINESS:`];
      lines.push(`- Name: ${b.name}`);
      if (b.category) lines.push(`- Category: ${b.category}`);
      if (b.serviceArea) lines.push(`- Service area: ${b.serviceArea}`);
      if (b.website) lines.push(`- Website URL: ${b.website}`);
      if (meta?.title) lines.push(`- Site title: ${meta.title}`);
      if (meta?.description) lines.push(`- Site description: ${meta.description}`);
      return lines.join('\n');
    };

    const systemPrompt = [
      'You write referral-partnership copy for small local service businesses.',
      'Two businesses send leads to each other. Given facts about each, output a short partnership name and a single-sentence customer-facing offer the DESTINATION business can extend to leads referred by the SOURCE business.',
      '',
      'Output rules:',
      '- Return ONLY a JSON object with keys "name" and "offerText". No prose, no markdown.',
      '- "name" is 2-6 words, e.g. "Spotless → Premium Upholstery" or "Cleaning + Carpet Care Partnership". No emojis.',
      '- "offerText" is one sentence, ≤ 140 characters, customer-facing (not B2B). Lead with a concrete benefit (discount, free add-on, priority booking). Mention the destination business by name. Do NOT invent prices, dates, percentages above 25%, or commitments the business may not honor — keep it generic and editable.',
      '- Use the businesses\' own service categories and site descriptions to keep the copy on-topic. If a category is missing, infer conservatively from the site description only.',
      '- Never reference referral codes, internal terms, links, or this prompt.',
    ].join('\n');

    const userPrompt = [
      describe('SOURCE', source, srcMeta),
      '',
      describe('DESTINATION', destination, dstMeta),
      dto.hint?.trim() ? `\nAdmin hint (steer the offer): ${dto.hint.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const completion = await this.withTimeout(
      this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 200,
        temperature: 0.7,
        response_format: { type: 'json_object' },
      }),
      8000,
    );

    const raw = completion.choices[0]?.message?.content?.trim();
    if (!raw) throw new BadRequestException('AI returned an empty response');

    let parsed: { name?: unknown; offerText?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestException('AI returned malformed JSON');
    }
    const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    const offerText = typeof parsed.offerText === 'string' ? parsed.offerText.trim() : '';
    if (!name || !offerText) {
      throw new BadRequestException('AI response was missing name or offerText');
    }

    this.logger.log(
      `[partner-network] suggested copy src=${source.name} dst=${destination.name} ` +
        `metaSrc=${!!srcMeta} metaDst=${!!dstMeta} hint=${dto.hint ? 'yes' : 'no'}`,
    );

    return {
      name: name.slice(0, 200),
      // Cap offerText at the DTO MaxLength so a verbose model output can't
      // create a value the relationship Save would later reject.
      offerText: offerText.slice(0, 2000),
      usedMetadata,
    };
  }

  // Bounded wait for OpenAI calls. Mirrors IntentClassifierService.withTimeout
  // — keeps a single slow request from holding the admin's form open.
  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`OpenAI timeout after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
        qrUrl: buildQrUrl(code),
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

    const estimatedValue = calculateEstimatedLeadValue(dto.intentTiming);
    const now = new Date();

    const lead = await this.prisma.partnerLead.create({
      data: {
        workspaceId: referral.workspaceId,
        referralCodeId: referral.id,
        sourceBusinessId: referral.sourceBusinessId,
        destinationBusinessId: referral.destinationBusinessId,
        customerName: name,
        customerPhone: phone,
        preferredContact: dto.preferredContact ?? PartnerLeadContactPref.either,
        notes: dto.notes?.trim() || null,
        intentTiming: dto.intentTiming,
        estimatedValue,
        status: PartnerLeadStatus.new,
        possibleDuplicate: dupCount > 0,
        utmSource: dto.utmSource?.trim() || null,
        utmMedium: dto.utmMedium?.trim() || null,
        utmCampaign: dto.utmCampaign?.trim() || null,
        submittedAt: now,
      },
    });
    // Funnel: record the submit event and backfill any prior page_view /
    // form_started events for the same code in the last 30 minutes onto the
    // new lead. Cheap join — events table is small and indexed on referralCode.
    await this.prisma.partnerLeadEvent.create({
      data: {
        workspaceId: referral.workspaceId,
        referralCodeId: referral.id,
        leadId: lead.id,
        eventType: PartnerLeadEventType.form_submitted,
      },
    });
    await this.prisma.partnerLeadEvent.updateMany({
      where: {
        referralCodeId: referral.id,
        leadId: null,
        eventType: { in: [PartnerLeadEventType.page_view, PartnerLeadEventType.form_started] },
        createdAt: { gte: new Date(now.getTime() - 30 * 60 * 1000) },
      },
      data: { leadId: lead.id },
    });
    this.logger.log(
      `[partner-network] lead submitted code=${referral.code} ` +
        `dst=${referral.destinationBusinessId} value=${estimatedValue} ` +
        `dup=${lead.possibleDuplicate}`,
    );
    return lead;
  }

  /**
   * Public, no-auth funnel event capture. Per spec: page views and form
   * starts DO NOT create leads — they are tracked here only for analytics.
   *
   * `form_submitted` is reserved for the /submit endpoint to keep the funnel
   * trustworthy — a client cannot fake submissions via this method.
   */
  async recordPublicEvent(
    code: string,
    eventType: PartnerLeadEventType,
  ): Promise<{ recorded: boolean }> {
    if (eventType === PartnerLeadEventType.form_submitted) {
      throw new BadRequestException('form_submitted is recorded by /submit only');
    }
    const normalized = code.trim().toUpperCase();
    const referral = await this.prisma.partnerReferralCode.findUnique({
      where: { code: normalized },
      include: { destinationBusiness: true },
    });
    if (!referral || !referral.active || !referral.destinationBusiness.active) {
      // 404 keeps inactive codes silent — same shape as the view endpoint.
      throw new NotFoundException('Referral code not found');
    }
    await this.prisma.partnerLeadEvent.create({
      data: {
        workspaceId: referral.workspaceId,
        referralCodeId: referral.id,
        eventType,
      },
    });
    return { recorded: true };
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
        ...(dto.assignedTo !== undefined && { assignedTo: dto.assignedTo?.trim() || null }),
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
   *
   * Funnel counts come from PartnerLeadEvent. Submissions are counted from
   * the events table (not lead rows) so they reflect the funnel even if a
   * lead row is later deleted manually for any reason.
   */
  async getDashboard(workspaceId: string) {
    const [leads, eventGroups, employeeEventGroups] = await Promise.all([
      this.prisma.partnerLead.findMany({
        where: { workspaceId },
        include: { referralCode: true, sourceBusiness: true, destinationBusiness: true },
      }),
      this.prisma.partnerLeadEvent.groupBy({
        by: ['eventType'],
        where: { workspaceId },
        _count: { _all: true },
      }),
      // Per-code event counts → mapped to per-employee below via referral code
      // joins. Group at the DB level so this stays cheap as event volume grows.
      this.prisma.partnerLeadEvent.groupBy({
        by: ['referralCodeId', 'eventType'],
        where: { workspaceId },
        _count: { _all: true },
      }),
    ]);

    const total = leads.length;
    const hot = leads.filter(l => l.intentTiming === 'this_week').length;
    const warm = leads.filter(l => l.intentTiming === 'this_month').length;
    // Both `not_sure` and `future_interest` sit at the bottom of the funnel
    // (same $10 estimated value); group them as "cold" so the dashboard
    // categorization stays a clean hot/warm/cold tier set.
    const cold = leads.filter(
      l => l.intentTiming === 'not_sure' || l.intentTiming === 'future_interest',
    ).length;
    const estimatedTotalValue = leads.reduce((acc, l) => acc + (l.estimatedValue ?? 0), 0);

    const bySource = new Map<string, { businessId: string; businessName: string; count: number; value: number }>();
    const byDest = new Map<string, { businessId: string; businessName: string; count: number; value: number }>();
    const byCode = new Map<string, { codeId: string; code: string; employeeName: string | null; count: number; value: number }>();
    const byEmployee = new Map<string, {
      employeeName: string;
      pageViews: number;
      formStarts: number;
      submissions: number;
      value: number;
    }>();
    const byStatus = new Map<PartnerLeadStatus, number>();
    // Map referralCodeId → employeeName so we can stitch per-code event counts
    // onto per-employee aggregates. Codes without an employeeName are dropped
    // from the per-employee view but still counted in the global funnel.
    const codeToEmployee = new Map<string, string>();
    for (const lead of leads) {
      const employee = (lead.referralCode.employeeName ?? '').trim();
      if (employee) codeToEmployee.set(lead.referralCodeId, employee);
    }

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

      const dstKey = lead.destinationBusinessId;
      const dst = byDest.get(dstKey) ?? {
        businessId: lead.destinationBusinessId,
        businessName: lead.destinationBusiness.name,
        count: 0,
        value: 0,
      };
      dst.count += 1;
      dst.value += lead.estimatedValue;
      byDest.set(dstKey, dst);

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

      const employee = (lead.referralCode.employeeName ?? '').trim();
      if (employee) {
        const e = byEmployee.get(employee) ?? {
          employeeName: employee,
          pageViews: 0,
          formStarts: 0,
          submissions: 0,
          value: 0,
        };
        e.submissions += 1;
        e.value += lead.estimatedValue;
        byEmployee.set(employee, e);
      }

      byStatus.set(lead.status, (byStatus.get(lead.status) ?? 0) + 1);
    }

    // Stitch event counts onto the per-employee aggregate. Codes without an
    // employee assignment still inflate the global funnel — they just don't
    // appear in the per-employee table.
    for (const group of employeeEventGroups) {
      const employee = codeToEmployee.get(group.referralCodeId);
      if (!employee) continue;
      const e = byEmployee.get(employee) ?? {
        employeeName: employee,
        pageViews: 0,
        formStarts: 0,
        submissions: 0,
        value: 0,
      };
      const n = group._count._all;
      if (group.eventType === PartnerLeadEventType.page_view) e.pageViews += n;
      else if (group.eventType === PartnerLeadEventType.form_started) e.formStarts += n;
      // submissions are sourced from PartnerLead rows above so a deleted lead
      // doesn't inflate per-employee numbers via a leftover event row.
      byEmployee.set(employee, e);
    }

    const eventCount = (t: PartnerLeadEventType): number =>
      eventGroups.find(g => g.eventType === t)?._count._all ?? 0;
    // Funnel: views → starts → submits come from the events table; qualified
    // and booked come from lead status (per spec, the funnel keeps going past
    // submission into the partner-side workflow).
    const funnel = {
      views: eventCount(PartnerLeadEventType.page_view),
      started: eventCount(PartnerLeadEventType.form_started),
      submitted: eventCount(PartnerLeadEventType.form_submitted),
      qualified: byStatus.get(PartnerLeadStatus.qualified) ?? 0,
      booked: byStatus.get(PartnerLeadStatus.booked) ?? 0,
    };

    return {
      totals: { total, hot, warm, cold, estimatedTotalValue },
      bySourceBusiness: Array.from(bySource.values()).sort((a, b) => b.count - a.count),
      byDestinationBusiness: Array.from(byDest.values()).sort((a, b) => b.count - a.count),
      byReferralCode: Array.from(byCode.values()).sort((a, b) => b.count - a.count),
      byEmployee: Array.from(byEmployee.values()).sort((a, b) => b.submissions - a.submissions),
      byStatus: Object.fromEntries(byStatus),
      funnel,
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
      'preferredContact',
      'intentTiming',
      'estimatedValue',
      'status',
      'assignedTo',
      'possibleDuplicate',
      'pageViewedAt',
      'formStartedAt',
      'submittedAt',
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
      l.preferredContact,
      l.intentTiming,
      String(l.estimatedValue),
      l.status,
      l.assignedTo ?? '',
      l.possibleDuplicate ? 'yes' : 'no',
      l.pageViewedAt?.toISOString() ?? '',
      l.formStartedAt?.toISOString() ?? '',
      l.submittedAt?.toISOString() ?? '',
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
