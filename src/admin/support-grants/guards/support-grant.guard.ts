/**
 * SupportGrantGuard — Phase 3
 *
 * Used in tandem with the `@RequiresSupportGrant('scope')` decorator.
 * On a guarded handler, this guard verifies that:
 *   1. The caller is authenticated and has role=ADMIN.
 *   2. They hold an unexpired SupportGrant whose `scopes` include the
 *      handler's required scope and whose `tenantId` matches the targeted
 *      resource (or is the platform-wide sentinel '__platform__').
 *
 * On any failure — non-admin, no grant, expired grant, wrong scope, wrong
 * tenant — throws NotFoundException so the caller can't distinguish "not
 * authorized" from "doesn't exist". Same convention as TenancyService.
 *
 * On success, the matched grant is stashed at `request.supportGrant` so the
 * downstream controller can reference its `reason` when calling AuditService
 * to write the support_read row.
 *
 * Target tenant resolution: looks at `request.params.userId` first
 * (matches `/v1/admin/users/:userId`), then `request.params.tenantId` for any
 * future route that uses that param name. Falls back to '__platform__' for
 * bulk endpoints that don't pin to a single tenant.
 */
import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SupportGrantsService } from '../support-grants.service';

export const SUPPORT_GRANT_SCOPE_KEY = 'supportGrantScope';

@Injectable()
export class SupportGrantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly supportGrantsService: SupportGrantsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const requiredScope = this.reflector.get<string>(SUPPORT_GRANT_SCOPE_KEY, ctx.getHandler());
    if (!requiredScope) return true;

    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    if (!user || user.role !== 'ADMIN') {
      throw new NotFoundException('Resource not found');
    }

    const targetTenantId = SupportGrantGuard.resolveTargetTenantId(request);

    const grant = await this.supportGrantsService.findActiveGrant(
      user.id,
      requiredScope,
      targetTenantId,
    );

    if (!grant) {
      throw new NotFoundException('Resource not found');
    }

    request.supportGrant = grant;
    return true;
  }

  /**
   * Pull the target tenant id from the request. Per-tenant admin routes carry
   * it as `:userId` or `:tenantId`. Bulk routes don't have a tenant param —
   * those default to the platform-wide sentinel.
   *
   * Exposed as a static method so unit tests can exercise the resolution
   * logic without instantiating a guard.
   */
  static resolveTargetTenantId(request: any): string {
    return (
      request?.params?.userId ??
      request?.params?.tenantId ??
      '__platform__'
    );
  }
}
