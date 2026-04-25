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

@Injectable()
export class ImpersonationGuard implements CanActivate {
  private readonly logger = new Logger(ImpersonationGuard.name);

  constructor(
    private prisma: PrismaService,
    private reflector: Reflector,
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

    // Log every impersonated request — including GETs. Reads of customer data
    // are sensitive and must leave an audit trail (see SECURITY_CONTROL_DATA.md
    // Phase 0). Full audit logging to DataAccessLog lands in a later phase;
    // for now this surfaces on the application logger → Loki.
    const method = request.method?.toUpperCase() || 'UNKNOWN';
    const kind = method === 'GET' || method === 'HEAD' ? 'read' : 'write';
    this.logger.log(
      `Impersonation ${kind}: admin ${request.impersonator.email} as ${targetUser.email} (${targetUser.id}) [${method} ${request.url}]`,
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
