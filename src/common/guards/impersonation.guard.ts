/**
 * Impersonation Guard
 * Allows ADMIN users to "view as" any other user by sending
 * the X-Impersonate-User header with the target user's ID.
 *
 * Stores the impersonated user in request.impersonatedAs (NOT request.user)
 * because many controllers have @UseGuards(JwtAuthGuard) at the class level,
 * which re-runs the Passport JWT strategy and overwrites request.user.
 * The @CurrentUser() decorator checks request.impersonatedAs first.
 */

import { Injectable, CanActivate, ExecutionContext, Logger, NestInterceptor, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { PrismaService } from '../utils/prisma.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class ImpersonationGuard implements CanActivate {
  private readonly logger = new Logger(ImpersonationGuard.name);

  constructor(
    private prisma: PrismaService,
    private reflector: Reflector,
    private auditService: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // Only process if user is authenticated and is ADMIN
    if (!user || user.role !== 'ADMIN') return true;

    const targetUserId = request.headers['x-impersonate-user'];
    if (!targetUserId || typeof targetUserId !== 'string') return true;

    // Don't allow impersonating yourself
    if (targetUserId === user.id) return true;

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!targetUser) {
      this.logger.warn(
        `Impersonation failed: user ${targetUserId} not found (admin: ${user.id})`,
      );
      return true;
    }

    // Store impersonated user separately so controller-level @UseGuards(JwtAuthGuard)
    // can't overwrite it (Passport re-runs the JWT strategy and resets request.user).
    request.impersonator = { ...user };
    request.impersonatedAs = {
      id: targetUser.id,
      email: targetUser.email,
      name: targetUser.name,
      role: targetUser.role,
      subscriptionTier: targetUser.subscriptionTier,
      subscriptionStatus: targetUser.subscriptionStatus,
      subscriptionPeriodEnd: targetUser.subscriptionPeriodEnd,
      hasOwnNumber: targetUser.hasOwnNumber,
    };

    // Phase 2: persist every impersonated request to DataAccessLog.
    // Reads (GET/HEAD) get accessType=impersonation_read; everything else
    // gets impersonation_write. The action mirrors the HTTP method for now;
    // a future phase will derive resourceType/resourceId from route params.
    const method = request.method?.toUpperCase() || 'UNKNOWN';
    const isRead = method === 'GET' || method === 'HEAD';
    const accessType = isRead ? 'impersonation_read' : 'impersonation_write';
    const action = isRead ? 'read' : (method === 'DELETE' ? 'delete' : method === 'POST' ? 'create' : 'update');

    const meta = AuditService.extractRequestMeta(request);

    // Fire-and-forget — AuditService swallows its own errors. We still keep
    // the application-logger line so Loki retains a low-latency human-readable
    // trail alongside the structured DB row.
    this.auditService.logAccess({
      actorUserId: request.impersonator.id,
      actorRole: request.impersonator.role || 'ADMIN',
      tenantId: targetUser.id,
      action,
      accessType,
      route: request.url,
      method,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    }).catch(err => this.logger.warn(`[Audit] impersonation log failed: ${err?.message}`));

    this.logger.log(
      `Impersonation ${isRead ? 'read' : 'write'}: admin ${request.impersonator.email} as ${targetUser.email} (${targetUser.id}) [${method} ${request.url}]`,
    );

    return true;
  }
}

/**
 * Interceptor that runs AFTER all guards (global + controller + route).
 * Copies request.impersonatedAs → request.user so that controllers using
 * req.user directly (not just @CurrentUser()) also see the impersonated user.
 *
 * Guard execution order:  Global JwtAuth → Global Impersonation → Controller JwtAuth
 * Interceptor runs AFTER all guards, so controller-level JwtAuth can't undo this.
 */
@Injectable()
export class ImpersonationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    if (request.impersonatedAs) {
      request.user = request.impersonatedAs;
    }
    return next.handle();
  }
}
