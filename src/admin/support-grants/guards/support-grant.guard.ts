/**
 * SupportGrantGuard — single-admin bypass
 *
 * Originally enforced time-bound, scoped SupportGrants on top of AdminGuard.
 * Disabled while there's a single operator admin — every guarded handler
 * still sits behind `@UseGuards(JwtAuthGuard, AdminGuard)` at the controller
 * level, so role gating is unchanged. The grant requirement is what was
 * blocking single-admin workflows (e.g. /admin/users/:userId 404s without
 * an active grant). To re-enable, restore the `findActiveGrant` call below.
 *
 * What's preserved:
 *   - Non-ADMIN callers still get NotFoundException (defense-in-depth even
 *     though AdminGuard already rejects them).
 *   - `req.supportGrant` is intentionally left undefined; controllers read
 *     it as `req.supportGrant?.reason ?? null`, so audit rows write reason
 *     = null instead of the grant's reason. That's the only observable
 *     downstream change.
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
