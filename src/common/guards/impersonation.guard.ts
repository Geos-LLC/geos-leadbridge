/**
 * Impersonation Guard
 * Allows ADMIN users to "view as" any other user by sending
 * the X-Impersonate-User header with the target user's ID.
 *
 * Registered as a global APP_GUARD after JwtAuthGuard so request.user
 * is already populated. Runs before route-level guards (AdminGuard,
 * FeatureGateGuard) so the swap takes effect everywhere.
 */

import { Injectable, CanActivate, ExecutionContext, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
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

    // Store original admin for audit trail
    request.impersonator = { ...user };

    // Replace request.user with target user (same shape as JwtStrategy.validate())
    request.user = {
      id: targetUser.id,
      email: targetUser.email,
      name: targetUser.name,
      role: targetUser.role,
      subscriptionTier: targetUser.subscriptionTier,
      subscriptionStatus: targetUser.subscriptionStatus,
      subscriptionPeriodEnd: targetUser.subscriptionPeriodEnd,
      hasOwnNumber: targetUser.hasOwnNumber,
    };

    this.logger.log(
      `Admin ${request.impersonator.email} impersonating ${targetUser.email} (${targetUser.id})`,
    );

    return true;
  }
}
