/**
 * Account-scope parsing for list endpoints.
 *
 * Backend rule (see `docs/ACCOUNT_BOUNDARY.md` and the hotfix PR notes):
 *
 *   tenant boundary  = userId    (always enforced by JwtAuthGuard / Prisma where: { userId })
 *   account boundary = businessId (THIS module — must filter list endpoints)
 *   platform boundary = platform   (filter on the same table column)
 *
 * Per-account list endpoints accept either:
 *   ?businessId=<id>   → scope to one saved account
 *   ?scope=all         → explicit unified view across all of the user's accounts
 *
 * `businessId` and `scope=all` together → 400 (caller is confused).
 *
 * Missing both → during the **transition window** this resolves to `{ kind: 'all',
 * warn: true }` so the existing UI keeps working while frontend code is updated
 * to always pass one of the two. After the transition window, callers should
 * flip `strict: true` in `parseAccountScope` to make missing scope a hard 400.
 *
 * The transition behavior is observable: the resolved value carries `warn: true`
 * which the controller turns into a `X-LeadBridge-Boundary-Warning` header and
 * a structured warning log. Both make it easy to grep and migrate every caller
 * before flipping to strict mode.
 */
import { BadRequestException } from '@nestjs/common';

export type AccountScope =
  | { kind: 'account'; businessId: string }
  | { kind: 'all'; warn: boolean };

export interface AccountScopeQuery {
  businessId?: string | null;
  scope?: string | null;
}

export interface ParseAccountScopeOptions {
  /**
   * When true, missing `businessId` AND missing `scope=all` throws BadRequestException.
   * When false (transition default), missing both resolves to `{ kind: 'all', warn: true }`.
   */
  strict?: boolean;
}

const SCOPE_ALL_VALUES = new Set(['all']);

/**
 * Returns a discriminated AccountScope describing the requested view, or throws
 * BadRequestException for malformed combinations.
 *
 * Throws on:
 *   - businessId AND scope set together (mutually exclusive)
 *   - scope set to anything other than 'all'
 *   - businessId is the literal string 'all' (ambiguous — caller must use scope=all)
 *   - missing both, when `strict: true`
 */
export function parseAccountScope(
  query: AccountScopeQuery,
  options: ParseAccountScopeOptions = {},
): AccountScope {
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
    return { kind: 'all', warn: false };
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

  // Neither was provided.
  if (options.strict) {
    throw new BadRequestException(
      'businessId or scope=all is required for this list endpoint',
    );
  }
  return { kind: 'all', warn: true };
}

/**
 * Header name used to surface transition-mode warnings to the frontend.
 * Frontend should log/track occurrences and update callers to pass an explicit scope.
 */
export const ACCOUNT_BOUNDARY_WARNING_HEADER = 'X-LeadBridge-Boundary-Warning';
export const ACCOUNT_BOUNDARY_WARNING_VALUE_MISSING = 'missing-business-id';
