/**
 * Account-scope parsing for list endpoints.
 *
 * Backend rule:
 *
 *   tenant boundary   = userId    (always enforced by JwtAuthGuard / Prisma where: { userId })
 *   account boundary  = businessId (THIS module — must filter list endpoints)
 *   platform boundary = platform   (filter on the same table column)
 *
 * Per-account list endpoints accept either:
 *   ?businessId=<id>   → scope to one saved account
 *   ?scope=all         → explicit unified view across all of the user's accounts
 *
 * Anything else throws `BadRequestException`:
 *   - businessId AND scope=all together  → mutually exclusive
 *   - scope set to anything other than 'all'
 *   - businessId === 'all' (ambiguous with scope=all)
 *   - **neither set** — strict-mode is the default; the frontend MUST pick a scope
 *
 * History: a transition mode previously allowed missing both and treated it as
 * unified, emitting a `X-LeadBridge-Boundary-Warning: missing-business-id`
 * header and a structured warn log so unmigrated callers were observable.
 * After a 24h+ Loki soak showed only stale-tab decay (last warning 35h before
 * the cleanup), the transition surface was removed. See PRs #136-#144 for the
 * full migration sequence.
 */
import { BadRequestException } from '@nestjs/common';

export type AccountScope =
  | { kind: 'account'; businessId: string }
  | { kind: 'all' };

export interface AccountScopeQuery {
  businessId?: string | null;
  scope?: string | null;
}

const SCOPE_ALL_VALUES = new Set(['all']);

/**
 * Returns a discriminated AccountScope describing the requested view, or throws
 * BadRequestException for any malformed or missing-scope query.
 */
export function parseAccountScope(query: AccountScopeQuery): AccountScope {
  const businessIdRaw = typeof query.businessId === 'string' ? query.businessId.trim() : '';
  const scopeRaw = typeof query.scope === 'string' ? query.scope.trim().toLowerCase() : '';

  const hasBusinessId = businessIdRaw !== '';
  const hasScope = scopeRaw !== '';

  if (hasBusinessId && hasScope) {
    throw new BadRequestException(
      'businessId and scope are mutually exclusive — pass one or the other, not both',
    );
  }

  if (hasScope) {
    if (!SCOPE_ALL_VALUES.has(scopeRaw)) {
      throw new BadRequestException(
        `unsupported scope value '${scopeRaw}' — only 'all' is accepted`,
      );
    }
    return { kind: 'all' };
  }

  if (hasBusinessId) {
    // Reject 'all' as a businessId — it would be ambiguous with scope=all.
    if (businessIdRaw.toLowerCase() === 'all') {
      throw new BadRequestException(
        "businessId='all' is ambiguous — use ?scope=all for the unified view",
      );
    }
    return { kind: 'account', businessId: businessIdRaw };
  }

  // Neither was provided — strict-mode is the default now.
  throw new BadRequestException(
    'businessId or scope=all is required for this list endpoint',
  );
}
