/**
 * JWT Authentication Strategy
 * Validates JWT tokens and extracts user information.
 *
 * Hot path note: this runs on EVERY authenticated request. Profiling found
 * the previous implementation issued a full-row prisma.user.findUnique
 * (~150-200ms cross-region RTT to Supabase) which dominated total endpoint
 * latency on every authed call.
 *
 * This implementation:
 *   1. Caches the per-user AuthUser shape under `auth:user:{userId}` with a
 *      120s TTL. Cache HIT path is sub-ms (Redis local fetch).
 *   2. On cache miss, projects only the 8 fields the rest of the app reads
 *      from req.user — never selects the wide globalAiPrompt @db.Text or
 *      the other ~20 columns the previous full-row pull included.
 *   3. Caches `null` for unknown userIds so a deleted user with a still-valid
 *      JWT stays auth-rejected for the TTL (rather than re-querying every
 *      request and still rejecting).
 *
 * Invalidation:
 *   - admin.deleteUser, users.deleteOwnAccount → must invalidate (security)
 *   - admin.updateUserSubscription            → invalidates (subscription
 *                                                fields are returned to client)
 *   - Other user.update sites (name, trial counters, AI prompt, …) rely on
 *     the 120s TTL — those fields either aren't in the cached shape or the
 *     short staleness is UX-acceptable.
 */

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/utils/prisma.service';
import { CacheService } from '../common/cache/cache.service';
import { CacheKeys } from '../common/cache/cache-keys';

const AUTH_USER_TTL_SECONDS = 120;

interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  subscriptionTier: string | null;
  subscriptionStatus: string | null;
  // ISO string after JSON round-trip from Redis. Not used in any in-process
  // Date arithmetic — only flows to JSON responses, where Date and string
  // serialize identically. Type widened to match the cache round-trip.
  subscriptionPeriodEnd: Date | string | null;
  hasOwnNumber: boolean;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    private cache: CacheService,
  ) {
    super({
      // Support token from Authorization header AND query parameter (for SSE/EventSource)
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        ExtractJwt.fromUrlQueryParameter('token'),
      ]),
      ignoreExpiration: false,
      algorithms: ['HS256'],
      secretOrKey: configService.getOrThrow<string>('jwt.secret'),
    });
  }

  async validate(payload: any) {
    const t0 = Date.now();
    const userId = payload.sub;
    const shortUid = (userId || '').slice(0, 8);
    let wasCacheHit = true; // flipped to false inside the loader

    const tLookupStart = Date.now();
    const user = await this.cache.getOrSet<AuthUser | null>(
      CacheKeys.authUser(userId),
      AUTH_USER_TTL_SECONDS,
      async () => {
        wasCacheHit = false;
        const u = await this.prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            subscriptionTier: true,
            subscriptionStatus: true,
            subscriptionPeriodEnd: true,
            hasOwnNumber: true,
          },
        });
        return u as AuthUser | null;
      },
    );
    const lookupMs = Date.now() - tLookupStart;
    const totalMs = Date.now() - t0;

    if (!user) {
      this.logger.log(`[auth] REJECT user=${shortUid} lookup=${lookupMs}ms total=${totalMs}ms reason=user_not_found`);
      throw new UnauthorizedException('User not found');
    }

    const tag = wasCacheHit ? 'HIT ' : 'MISS';
    this.logger.log(`[auth] ${tag} user=${shortUid} lookup=${lookupMs}ms total=${totalMs}ms`);
    return user;
  }
}
