/**
 * Tenancy Service
 *
 * Central helpers for enforcing per-tenant (per-User) data access. Every
 * customer-data table in this codebase is scoped by `userId` — either directly
 * on the row or via a relation (Conversation.userId → FollowUpEnrollment,
 * ThreadContext, Message, etc.).
 *
 * Always throw NotFoundException on a mismatch (never ForbiddenException): a
 * 403 tells an attacker the record exists; a 404 does not.
 *
 * Phase 0 scope: helpers used by conversation-context and follow-up-engine
 * controllers. Additional model helpers will land in later phases as the
 * endpoint sweep expands.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../utils/prisma.service';

@Injectable()
export class TenancyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Verify that a Conversation belongs to the given user.
   * Throws NotFoundException if the conversation does not exist OR is owned
   * by another user.
   */
  async requireConversationAccess(conversationId: string, userId: string): Promise<void> {
    const row = await this.prisma.conversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Conversation not found');
  }

  /**
   * Verify that a FollowUpEnrollment belongs to the given user.
   * Ownership is inherited through Conversation.userId.
   */
  async requireEnrollmentAccess(enrollmentId: string, userId: string): Promise<void> {
    const row = await this.prisma.followUpEnrollment.findFirst({
      where: { id: enrollmentId, conversation: { userId } },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Enrollment not found');
  }

  /**
   * Verify that a LeadCallConnect session belongs to the given user.
   * Ownership is inherited through Lead.userId.
   */
  async requireCallConnectSessionAccess(sigcoreSessionId: string, userId: string): Promise<void> {
    const row = await this.prisma.leadCallConnect.findFirst({
      where: { sigcoreSessionId, lead: { userId } },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Session not found');
  }

  /**
   * Verify that a SystemErrorLog row belongs to the given user. The SystemErrorLog
   * table has nullable userId (system-level errors with no owner), so we explicitly
   * require a non-null match to prevent users from resolving system rows.
   */
  async requireSystemErrorAccess(errorId: string, userId: string): Promise<void> {
    const row = await this.prisma.systemErrorLog.findFirst({
      where: { id: errorId, userId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Error log not found');
  }

  /**
   * Generic ownership check for Prisma models with a top-level `userId` column.
   * Callers must pass a model name that exists on the Prisma client and that
   * has a `userId` scalar — e.g. 'lead', 'savedAccount', 'platform',
   * 'messageTemplate'. Models with inherited ownership (e.g. Message,
   * FollowUpEnrollment) should use a model-specific helper instead.
   */
  async requireTenantAccess(
    model:
      | 'lead'
      | 'savedAccount'
      | 'platform'
      | 'messageTemplate'
      | 'notificationSettings'
      | 'crmWebhookSubscription'
      | 'automationRule'
      | 'callConnectSettings'
      | 'tenantPhoneNumber',
    recordId: string,
    userId: string,
  ): Promise<void> {
    const delegate = (this.prisma as any)[model];
    if (!delegate || typeof delegate.findFirst !== 'function') {
      throw new Error(`TenancyService.requireTenantAccess: unknown model '${model}'`);
    }
    const row = await delegate.findFirst({
      where: { id: recordId, userId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Resource not found');
  }

  /**
   * Merge a tenant filter into a Prisma `where` clause. Intended for list
   * queries where you already compose a dynamic where object — use this
   * instead of spreading userId manually so the scoping is visible in review.
   */
  scopeQueryToTenant<W extends Record<string, unknown>>(
    where: W,
    userId: string,
    field: 'userId' | 'organizationId' = 'userId',
  ): W & Record<string, string> {
    return { ...where, [field]: userId } as W & Record<string, string>;
  }

  /**
   * Assert an in-memory entity belongs to the given user. Use when a record
   * has already been loaded and you want to verify ownership before acting on
   * it. Throws NotFoundException rather than leaking existence.
   */
  assertTenantOwnership<T extends { userId?: string | null } | null | undefined>(
    entity: T,
    userId: string,
  ): asserts entity is NonNullable<T> & { userId: string } {
    if (!entity || entity.userId !== userId) {
      throw new NotFoundException('Resource not found');
    }
  }
}
