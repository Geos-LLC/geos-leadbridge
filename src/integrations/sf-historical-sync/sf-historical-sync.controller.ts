/**
 * SfHistoricalSyncController — admin + SF receiver endpoints for the
 * SF→LB historical reconciliation. Three groups of routes:
 *
 *   Admin (JWT + support-grant gated):
 *     POST /v1/admin/sf/sync/dashboard            — counts + match-key inventory
 *     GET  /v1/admin/sf/sync/candidates           — paged list for operator UI
 *     POST /v1/admin/sf/sync/trigger              — "Sync from ServiceFlow"
 *                                                    re-enumeration; idempotent
 *     POST /v1/admin/sf/sync/manual-link          — operator submits link
 *
 *   SF receiver (HMAC-signed, public route):
 *     POST /api/v1/integrations/sf/link-leads-bulk — SF posts match results
 *
 * Architecture: SF is source of truth. None of these endpoints create SF
 * records. The HMAC pattern mirrors sf-connection.controller.ts's
 * /provision endpoint (same SF_LB_PROVISIONING_SHARED_SECRET; same
 * canonical signing payload). Headers use the X-SF-LB-* prefix.
 */

import {
  Body, Controller, Get, Headers, HttpCode, HttpStatus, Logger, Param,
  Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../../admin/guards/admin.guard';
import { RequiresSupportGrant } from '../../admin/support-grants/decorators/requires-support-grant.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AuditService } from '../../common/audit/audit.service';
import { PLATFORM_BULK_TENANT_ID } from '../../admin/support-grants/support-grants.service';
import { SfHistoricalSyncService } from './sf-historical-sync.service';
import type {
  BulkLinkRequest, ManualLinkRequest, SyncTriggerRequest,
} from './sf-historical-sync.contracts';

const SF_PROV_SIGNATURE_SKEW_SECONDS = 300;

@Controller()
export class SfHistoricalSyncController {
  private readonly logger = new Logger(SfHistoricalSyncController.name);

  constructor(
    private readonly sync: SfHistoricalSyncService,
    private readonly config: ConfigService,
    private readonly auditService: AuditService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════
  // Admin endpoints (JWT + AdminGuard + support-grant)
  // ═══════════════════════════════════════════════════════════════════

  @Post('v1/admin/sf/sync/dashboard')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @RequiresSupportGrant('sf:sync:read')
  async dashboard(@Req() req: any, @Body() body: { userId: string }) {
    await this.auditService.logAccess({
      actorUserId: req.user.id,
      actorRole: 'ADMIN',
      tenantId: body.userId || PLATFORM_BULK_TENANT_ID,
      action: 'read',
      resourceType: 'SfHistoricalSync',
      resourceId: body.userId,
      accessType: 'support_read',
      reason: req.supportGrant?.reason ?? null,
      route: req.url,
      method: req.method,
    });
    return { success: true, data: await this.sync.dashboard(body.userId) };
  }

  @Get('v1/admin/sf/sync/candidates')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @RequiresSupportGrant('sf:sync:read')
  async candidates(
    @Req() req: any,
    @Query('userId') userId: string,
    @Query('syncStatus') syncStatus?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    await this.auditService.logAccess({
      actorUserId: req.user.id,
      actorRole: 'ADMIN',
      tenantId: userId || PLATFORM_BULK_TENANT_ID,
      action: 'read',
      resourceType: 'SfHistoricalSync',
      resourceId: 'candidates:' + (userId || 'all'),
      accessType: 'support_read',
      reason: req.supportGrant?.reason ?? null,
      route: req.url,
      method: req.method,
    });
    const rows = await this.sync.candidates(userId, {
      syncStatus: syncStatus === 'null' ? null : (syncStatus as any),
      status,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
    return { success: true, count: rows.length, data: rows };
  }

  @Post('v1/admin/sf/sync/trigger')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @RequiresSupportGrant('sf:sync:write')
  async trigger(@Req() req: any, @Body() body: { userId: string } & SyncTriggerRequest) {
    await this.auditService.logAccess({
      actorUserId: req.user.id,
      actorRole: 'ADMIN',
      tenantId: body.userId || PLATFORM_BULK_TENANT_ID,
      action: 'sync_trigger',
      resourceType: 'SfHistoricalSync',
      resourceId: body.userId,
      accessType: 'support_write',
      reason: req.supportGrant?.reason ?? null,
      route: req.url,
      method: req.method,
    });
    return { success: true, data: await this.sync.enumerateOnTrigger(body.userId, body) };
  }

  @Post('v1/admin/sf/sync/manual-link')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @RequiresSupportGrant('sf:sync:write')
  async manualLink(@Req() req: any, @Body() body: ManualLinkRequest) {
    await this.auditService.logAccess({
      actorUserId: req.user.id,
      actorRole: 'ADMIN',
      tenantId: PLATFORM_BULK_TENANT_ID,
      action: 'manual_link',
      resourceType: 'Lead',
      resourceId: body.lbLeadId,
      accessType: 'support_write',
      reason: req.supportGrant?.reason ?? null,
      route: req.url,
      method: req.method,
    });
    const r = await this.sync.manualLink(req.user.id, body);
    return { success: r.ok, data: r };
  }

  // ═══════════════════════════════════════════════════════════════════
  // SF receiver (HMAC-signed public route)
  // ═══════════════════════════════════════════════════════════════════
  //
  // Mirrors the /provision HMAC pattern. SF posts batched match results;
  // LB applies them with safeguards (no-overwrite-different-sfJobId,
  // confidence-driven needs_review / no_match, status updates routed
  // through the existing writeStatus guards).

  // Path is relative to the global `/api` prefix set in main.ts, so the
  // full route is /api/v1/integrations/sf/link-leads-bulk.
  @Public()
  @Post('v1/integrations/sf/link-leads-bulk')
  @HttpCode(HttpStatus.OK)
  async bulkLink(@Req() req: Request, @Body() body: BulkLinkRequest) {
    const rawBody = this.getRawBody(req);
    const hmac = this.verifyProvisioningHmac(rawBody, req.headers);
    if (!hmac.ok) {
      this.logger.warn(`[SfHistoricalSync] event=bulk_link_hmac_rejected reason=${hmac.reason}`);
      return {
        ok: false, error: hmac.reason,
        summary: { total: 0, linked: 0, needs_review: 0, no_match: 0, conflict: 0, not_found: 0, failed: 0, status_updates_applied: 0 },
        rows: [],
      };
    }
    if (!body?.rows || !Array.isArray(body.rows)) {
      return {
        ok: false, error: 'invalid_body',
        summary: { total: 0, linked: 0, needs_review: 0, no_match: 0, conflict: 0, not_found: 0, failed: 0, status_updates_applied: 0 },
        rows: [],
      };
    }
    return await this.sync.applyBulkLink(body);
  }

  // ─── helpers (duplicated from sf-connection.controller.ts; a future
  //     refactor could extract a shared HmacProvisioningVerifier) ────

  private getRawBody(req: Request): string {
    const rawBuf = (req as any).rawBody as Buffer | undefined;
    if (rawBuf) return rawBuf.toString('utf8');
    if (typeof req.body === 'string') return req.body;
    return JSON.stringify(req.body ?? {});
  }

  private verifyProvisioningHmac(
    rawBody: string,
    headers: Record<string, any>,
  ): { ok: true } | { ok: false; reason: string } {
    const pick = (k: string): string | null => {
      const v = headers[k] ?? headers[k.toLowerCase()];
      if (!v) return null;
      return Array.isArray(v) ? (v[0] ?? null) : String(v);
    };
    const ts = pick('x-sf-lb-timestamp');
    const sig = pick('x-sf-lb-signature');
    if (!ts || !sig) return { ok: false, reason: 'missing_headers' };

    const secret = this.config.get<string>('SF_LB_PROVISIONING_SHARED_SECRET', '') ?? '';
    if (!secret) {
      this.logger.error('[SfHistoricalSync] event=config_missing var=SF_LB_PROVISIONING_SHARED_SECRET');
      return { ok: false, reason: 'config_missing' };
    }

    const tsNum = parseInt(ts, 10);
    if (!Number.isFinite(tsNum)) return { ok: false, reason: 'invalid_timestamp' };
    const drift = Math.floor(Date.now() / 1000) - tsNum;
    if (Math.abs(drift) > SF_PROV_SIGNATURE_SKEW_SECONDS) {
      return { ok: false, reason: 'timestamp_drift' };
    }

    const expected = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
    const received = sig.startsWith('sha256=') ? sig.slice('sha256='.length) : sig;
    if (expected.length !== received.length) return { ok: false, reason: 'signature_mismatch' };
    try {
      if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'))) {
        return { ok: false, reason: 'signature_mismatch' };
      }
    } catch {
      return { ok: false, reason: 'signature_mismatch' };
    }
    return { ok: true };
  }
}
