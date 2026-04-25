/**
 * Audit Service — Phase 2
 *
 * Records security-relevant access events to `data_access_logs`.
 *
 * Logging policy (per SECURITY_CONTROL_DATA.md Phase 2):
 *   - Log admin/support reads of customer data.
 *   - Log impersonated reads and writes.
 *   - Log sensitive tenant writes (create/update/delete on customer-data tables).
 *   - Log exports and account/security actions.
 *   - DO NOT log every normal tenant read.
 *
 * Forbidden in any persisted field: message bodies, full PII, tokens, secrets,
 * webhook payloads, AI prompts/responses, credentials. The schema only allows
 * 13 named fields (no JSON metadata blob), so the surface for accidental leaks
 * is small. The `reason` free-text field is masked via `sanitizeReason()`.
 *
 * This service never throws — audit failures must not break the request path.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../utils/prisma.service';
import { capField, sanitizeReason, stripQuery } from './sanitize';

/**
 * Resource types treated as sensitive — the canonical list from the
 * Phase 2 spec. Additions belong here so callers don't drift.
 */
export const SENSITIVE_RESOURCE_TYPES = [
  'Lead',
  'Customer',
  'Conversation',
  'Message',
  'FollowUpEnrollment',
  'Integration',
  'NotificationSettings',
  'CallConnectSettings',
  'MessageTemplate',
  'CrmWebhookSubscription',
  'Platform',
  'WebhookEvent',
] as const;

export type SensitiveResourceType = typeof SENSITIVE_RESOURCE_TYPES[number];

/**
 * Granular `accessType` values. Aligned with the Phase 4 admin/support
 * split that lands in a later PR — the column is forward-compatible so
 * later phases don't require a migration.
 */
export type AuditAccessType =
  | 'tenant_self'           // tenant acting on their own data (sensitive writes only)
  | 'impersonation_read'    // admin viewing tenant data via X-Impersonate-User
  | 'impersonation_write'   // admin mutating tenant data via X-Impersonate-User
  | 'admin_read'            // admin reading raw customer data (no impersonation)
  | 'support_read'          // support agent reading via an active SupportGrant (Phase 3)
  | 'export';               // tenant or admin exporting data

export type AuditAction = 'read' | 'list' | 'create' | 'update' | 'delete' | 'export';

export interface LogAccessInput {
  actorUserId: string;
  actorRole: string;
  tenantId: string;
  action: AuditAction | string;
  accessType: AuditAccessType | string;
  resourceType?: string | null;
  resourceId?: string | null;
  reason?: string | null;
  route?: string | null;
  method?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persist a data access event. Returns the row id on success, null on
   * failure. Never throws — audit failure must not break the request.
   */
  async logAccess(input: LogAccessInput): Promise<string | null> {
    try {
      const row = await this.prisma.dataAccessLog.create({
        data: {
          actorUserId: input.actorUserId,
          actorRole: capField('actorRole', input.actorRole) ?? 'UNKNOWN',
          tenantId: input.tenantId,
          action: capField('action', input.action) ?? 'unknown',
          accessType: capField('accessType', input.accessType) ?? 'unknown',
          resourceType: capField('resourceType', input.resourceType ?? null),
          resourceId: capField('resourceId', input.resourceId ?? null),
          // Reason is the only free-text field — sanitize masks PII and
          // refuses bearer tokens / long opaque secrets entirely.
          reason: sanitizeReason(input.reason),
          // Strip query strings — they can carry tokens or PII.
          route: capField('route', stripQuery(input.route ?? null)),
          method: capField('method', input.method ?? null),
          ipAddress: capField('ipAddress', input.ipAddress ?? null),
          userAgent: capField('userAgent', input.userAgent ?? null),
        },
        select: { id: true },
      });
      return row.id;
    } catch (err: any) {
      // Do not rethrow — surface to logs instead.
      this.logger.warn(`[Audit] Failed to persist access log: ${err.message}`);
      return null;
    }
  }

  /**
   * Convenience helper: extract IP and User-Agent from an Express request.
   * Pulled out so callers don't sprinkle `req.headers['x-forwarded-for']`
   * incantations through their guards/controllers.
   */
  static extractRequestMeta(request: any): { ipAddress: string | null; userAgent: string | null } {
    const xff = request?.headers?.['x-forwarded-for'];
    const xffFirst = typeof xff === 'string' ? xff.split(',')[0]?.trim() : Array.isArray(xff) ? xff[0] : null;
    return {
      ipAddress: xffFirst || request?.ip || null,
      userAgent: request?.headers?.['user-agent'] || null,
    };
  }
}
