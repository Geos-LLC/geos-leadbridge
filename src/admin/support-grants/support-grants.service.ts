/**
 * SupportGrantsService — Phase 3
 *
 * Time-bound, scope-limited authorization for ADMIN reads of customer data.
 * Pairs with `data_access_logs` rows where accessType = 'support_read' for
 * a who/what/why audit chain.
 *
 * Default duration on `createGrant`: 60 minutes. Hard cap: 7 days (10080 min).
 *
 * `findActiveGrant` is the hot-path used by SupportGrantGuard on every
 * protected admin request — must stay fast (one indexed Prisma query).
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/utils/prisma.service';
import { CreateSupportGrantDto } from './dto/create-support-grant.dto';

/**
 * Sentinel `tenantId` value indicating a grant authorizes platform-wide
 * (cross-tenant) access. Used by bulk admin endpoints that don't pin to a
 * single tenant — `/admin/notification-logs`, `/admin/tenant-numbers`,
 * `/admin/tenant-errors`. A grant with this tenantId also satisfies
 * per-tenant requests (admin holding platform-wide auth can view any tenant).
 */
export const PLATFORM_BULK_TENANT_ID = '__platform__';

/** 7 days = max grant lifetime, in minutes. */
const MAX_DURATION_MINUTES = 7 * 24 * 60;
/** Default lifetime when caller omits `durationMinutes`. */
const DEFAULT_DURATION_MINUTES = 60;
/** Cap on the persisted reason text to bound forensic-storage growth. */
const REASON_MAX_LENGTH = 500;

@Injectable()
export class SupportGrantsService {
  private readonly logger = new Logger(SupportGrantsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new SupportGrant. Caller is the admin who will use the grant.
   * Validation:
   *   - reason must be non-empty (audit context is mandatory)
   *   - scopes must be a non-empty array of strings
   *   - tenantId must be a non-empty string
   *   - durationMinutes is clamped to [1, 10080] with default 60
   */
  async createGrant(adminUserId: string, dto: CreateSupportGrantDto) {
    if (!dto.tenantId || typeof dto.tenantId !== 'string') {
      throw new BadRequestException('tenantId is required');
    }
    if (!Array.isArray(dto.scopes) || dto.scopes.length === 0) {
      throw new BadRequestException('scopes must be a non-empty array');
    }
    if (!dto.scopes.every(s => typeof s === 'string' && s.length > 0)) {
      throw new BadRequestException('every scope must be a non-empty string');
    }
    const trimmedReason = (dto.reason || '').trim();
    if (!trimmedReason) {
      throw new BadRequestException('reason is required');
    }

    const requested = dto.durationMinutes;
    const durationMinutes = requested == null
      ? DEFAULT_DURATION_MINUTES
      : Math.min(Math.max(Math.floor(requested), 1), MAX_DURATION_MINUTES);
    const expiresAt = new Date(Date.now() + durationMinutes * 60_000);

    const grant = await this.prisma.supportGrant.create({
      data: {
        adminUserId,
        tenantId: dto.tenantId,
        scopes: dto.scopes,
        reason: trimmedReason.slice(0, REASON_MAX_LENGTH),
        expiresAt,
      },
    });

    this.logger.log(
      `[SupportGrant] issued id=${grant.id} admin=${adminUserId} tenant=${dto.tenantId} ` +
      `scopes=[${dto.scopes.join(',')}] expiresAt=${expiresAt.toISOString()}`,
    );
    return grant;
  }

  /**
   * Hot-path lookup used by SupportGrantGuard. Returns the first non-expired
   * grant held by `adminUserId` whose `scopes` include `requiredScope` and
   * whose `tenantId` is either `targetTenantId` or the platform-wide sentinel.
   * Returns null when no such grant exists.
   */
  async findActiveGrant(
    adminUserId: string,
    requiredScope: string,
    targetTenantId: string,
  ) {
    return this.prisma.supportGrant.findFirst({
      where: {
        adminUserId,
        scopes: { has: requiredScope },
        expiresAt: { gt: new Date() },
        OR: [
          { tenantId: targetTenantId },
          { tenantId: PLATFORM_BULK_TENANT_ID },
        ],
      },
    });
  }
}
