/**
 * POST /v1/me/support-grants — input DTO.
 *
 * Validation rules enforced at the service layer:
 *   - reason is required (non-empty)
 *   - scopes is non-empty array of strings
 *   - durationMinutes is clamped: default 60, max 10080 (7 days)
 *   - tenantId is the target tenant id; pass '__platform__' to authorize
 *     access to bulk admin endpoints that span multiple tenants
 */
export class CreateSupportGrantDto {
  tenantId!: string;
  scopes!: string[];
  reason!: string;
  durationMinutes?: number;
}
