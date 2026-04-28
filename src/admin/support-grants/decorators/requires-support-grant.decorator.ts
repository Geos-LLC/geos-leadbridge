/**
 * @RequiresSupportGrant('scope') — Phase 3
 *
 * Combined metadata + guard. On a route handler decorated with this:
 *
 *   1. SetMetadata records the required scope so SupportGrantGuard knows
 *      what to check.
 *   2. UseGuards installs SupportGrantGuard for this handler.
 *
 * Apply on top of the existing `@UseGuards(JwtAuthGuard, AdminGuard)` at the
 * controller class — this decorator adds the support-grant check on top of
 * (not in place of) those existing guards. Order: JWT first, then Admin role,
 * then SupportGrant scope. All three must pass.
 */
import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import { SUPPORT_GRANT_SCOPE_KEY, SupportGrantGuard } from '../guards/support-grant.guard';

export const RequiresSupportGrant = (scope: string) =>
  applyDecorators(
    SetMetadata(SUPPORT_GRANT_SCOPE_KEY, scope),
    UseGuards(SupportGrantGuard),
  );
