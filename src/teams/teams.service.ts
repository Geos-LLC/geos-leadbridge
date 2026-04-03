/**
 * Teams Service
 *
 * Core business logic for team/organization management.
 * Handles: create org, invite, accept, remove, role changes.
 * One org per user. SavedAccount is the sharing boundary.
 */

import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';

@Injectable()
export class TeamsService {
  private readonly logger = new Logger(TeamsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new organization. The creating user becomes OWNER.
   * Their existing SavedAccounts get linked to the org.
   */
  async createOrg(userId: string, name: string) {
    // Check user doesn't already belong to an org
    const existing = await this.prisma.orgMembership.findFirst({ where: { userId } });
    if (existing) throw new BadRequestException('You already belong to an organization');

    const org = await this.prisma.organization.create({
      data: {
        name,
        members: {
          create: { userId, role: 'OWNER' },
        },
      },
      include: { members: { include: { user: { select: { id: true, name: true, email: true } } } } },
    });

    // Link existing SavedAccounts to the org
    await this.prisma.savedAccount.updateMany({
      where: { userId },
      data: { organizationId: org.id },
    });

    this.logger.log(`Organization "${name}" created by user ${userId} (${org.id})`);
    return org;
  }

  /**
   * Get user's organization with members.
   */
  async getMyOrg(userId: string) {
    const membership = await this.prisma.orgMembership.findFirst({
      where: { userId },
      include: {
        organization: {
          include: {
            members: {
              include: { user: { select: { id: true, name: true, email: true } } },
              orderBy: { joinedAt: 'asc' },
            },
            invitations: {
              where: { acceptedAt: null, expiresAt: { gt: new Date() } },
              orderBy: { createdAt: 'desc' },
            },
          },
        },
      },
    });

    if (!membership) return null;

    return {
      organization: membership.organization,
      myRole: membership.role,
    };
  }

  /**
   * Invite a user by email. Only OWNER and ADMIN can invite.
   */
  async invite(userId: string, email: string, role: 'ADMIN' | 'MEMBER' = 'MEMBER') {
    const { org, myRole } = await this.requireOrgRole(userId, ['OWNER', 'ADMIN']);

    // Cannot invite as OWNER
    if ((role as string) === 'OWNER') throw new BadRequestException('Cannot invite as OWNER');

    // ADMIN can only invite MEMBER
    if (myRole === 'ADMIN' && role === 'ADMIN') throw new ForbiddenException('Admins can only invite members');

    // Check if already a member
    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      const existingMembership = await this.prisma.orgMembership.findFirst({
        where: { userId: existingUser.id, organizationId: org.id },
      });
      if (existingMembership) throw new BadRequestException('User is already a member');
    }

    // Upsert invitation (re-sends if already pending)
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    const invitation = await this.prisma.orgInvitation.upsert({
      where: { organizationId_email: { organizationId: org.id, email } },
      create: {
        organizationId: org.id,
        email,
        role: role as any,
        invitedBy: userId,
        expiresAt,
      },
      update: {
        role: role as any,
        invitedBy: userId,
        expiresAt,
        acceptedAt: null, // Reset if re-inviting
      },
    });

    this.logger.log(`Invitation sent: ${email} → org ${org.id} as ${role} (by ${userId})`);

    // TODO: Send invitation email with link containing invitation.token
    return { invitation, inviteLink: `/invite/accept?token=${invitation.token}` };
  }

  /**
   * Accept an invitation by token. Creates membership + links accounts.
   */
  async acceptInvite(userId: string, token: string) {
    const invitation = await this.prisma.orgInvitation.findUnique({
      where: { token },
      include: { organization: true },
    });

    if (!invitation) throw new NotFoundException('Invitation not found');
    if (invitation.acceptedAt) throw new BadRequestException('Invitation already accepted');
    if (invitation.expiresAt < new Date()) throw new BadRequestException('Invitation has expired');

    // Verify email matches
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.email !== invitation.email) {
      throw new ForbiddenException('This invitation was sent to a different email address');
    }

    // Check user doesn't already belong to an org
    const existing = await this.prisma.orgMembership.findFirst({ where: { userId } });
    if (existing) throw new BadRequestException('You already belong to an organization');

    // Create membership
    await this.prisma.orgMembership.create({
      data: {
        organizationId: invitation.organizationId,
        userId,
        role: invitation.role,
      },
    });

    // Mark invitation as accepted
    await this.prisma.orgInvitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    });

    // Link user's existing SavedAccounts to the org
    await this.prisma.savedAccount.updateMany({
      where: { userId },
      data: { organizationId: invitation.organizationId },
    });

    this.logger.log(`User ${userId} accepted invite to org ${invitation.organizationId} as ${invitation.role}`);
    return { organizationId: invitation.organizationId, role: invitation.role };
  }

  /**
   * Remove a member from the organization.
   */
  async removeMember(requesterId: string, targetUserId: string) {
    const { org, myRole } = await this.requireOrgRole(requesterId, ['OWNER', 'ADMIN']);

    if (requesterId === targetUserId) throw new BadRequestException('Cannot remove yourself');

    const targetMembership = await this.prisma.orgMembership.findFirst({
      where: { organizationId: org.id, userId: targetUserId },
    });
    if (!targetMembership) throw new NotFoundException('User is not a member');

    // ADMIN cannot remove OWNER or other ADMINs
    if (myRole === 'ADMIN' && targetMembership.role !== 'MEMBER') {
      throw new ForbiddenException('Admins can only remove members');
    }

    await this.prisma.orgMembership.delete({ where: { id: targetMembership.id } });

    // Unlink target's SavedAccounts from org
    await this.prisma.savedAccount.updateMany({
      where: { userId: targetUserId, organizationId: org.id },
      data: { organizationId: null },
    });

    this.logger.log(`User ${targetUserId} removed from org ${org.id} by ${requesterId}`);
    return { success: true };
  }

  /**
   * Update a member's role. Only OWNER can do this.
   */
  async updateRole(requesterId: string, targetUserId: string, newRole: 'ADMIN' | 'MEMBER') {
    const { org } = await this.requireOrgRole(requesterId, ['OWNER']);

    if (requesterId === targetUserId) throw new BadRequestException('Cannot change your own role');

    const targetMembership = await this.prisma.orgMembership.findFirst({
      where: { organizationId: org.id, userId: targetUserId },
    });
    if (!targetMembership) throw new NotFoundException('User is not a member');

    await this.prisma.orgMembership.update({
      where: { id: targetMembership.id },
      data: { role: newRole as any },
    });

    this.logger.log(`Role changed: user ${targetUserId} → ${newRole} in org ${org.id} (by ${requesterId})`);
    return { success: true };
  }

  /**
   * Revoke a pending invitation.
   */
  async revokeInvitation(requesterId: string, invitationId: string) {
    const { org } = await this.requireOrgRole(requesterId, ['OWNER', 'ADMIN']);

    const invitation = await this.prisma.orgInvitation.findFirst({
      where: { id: invitationId, organizationId: org.id },
    });
    if (!invitation) throw new NotFoundException('Invitation not found');

    await this.prisma.orgInvitation.delete({ where: { id: invitationId } });
    return { success: true };
  }

  /**
   * Delete the organization entirely. Only OWNER.
   */
  async deleteOrg(requesterId: string) {
    const { org } = await this.requireOrgRole(requesterId, ['OWNER']);

    // Unlink all SavedAccounts
    await this.prisma.savedAccount.updateMany({
      where: { organizationId: org.id },
      data: { organizationId: null },
    });

    // Cascade deletes memberships + invitations
    await this.prisma.organization.delete({ where: { id: org.id } });

    this.logger.log(`Organization ${org.id} deleted by ${requesterId}`);
    return { success: true };
  }

  /**
   * Leave organization (non-owner).
   */
  async leaveOrg(userId: string) {
    const membership = await this.prisma.orgMembership.findFirst({ where: { userId } });
    if (!membership) throw new BadRequestException('Not in an organization');
    if (membership.role === 'OWNER') throw new BadRequestException('Owner cannot leave — transfer ownership or delete the organization');

    await this.prisma.orgMembership.delete({ where: { id: membership.id } });

    // Unlink user's accounts
    await this.prisma.savedAccount.updateMany({
      where: { userId, organizationId: membership.organizationId },
      data: { organizationId: null },
    });

    this.logger.log(`User ${userId} left org ${membership.organizationId}`);
    return { success: true };
  }

  // ==========================================
  // Access resolution (used by TeamsAccessGuard)
  // ==========================================

  /**
   * Get all SavedAccount IDs accessible to a user (own + org shared).
   */
  async getAccessibleAccountIds(userId: string): Promise<string[]> {
    const membership = await this.prisma.orgMembership.findFirst({ where: { userId } });

    if (!membership) {
      // No org — return only own accounts
      const accounts = await this.prisma.savedAccount.findMany({
        where: { userId },
        select: { id: true },
      });
      return accounts.map(a => a.id);
    }

    // In an org — return all org accounts
    const accounts = await this.prisma.savedAccount.findMany({
      where: { organizationId: membership.organizationId },
      select: { id: true },
    });
    return accounts.map(a => a.id);
  }

  /**
   * Get all businessIds accessible to a user (for lead filtering).
   */
  async getAccessibleBusinessIds(userId: string): Promise<string[]> {
    const membership = await this.prisma.orgMembership.findFirst({ where: { userId } });

    if (!membership) {
      const accounts = await this.prisma.savedAccount.findMany({
        where: { userId },
        select: { businessId: true },
      });
      return accounts.map(a => a.businessId);
    }

    const accounts = await this.prisma.savedAccount.findMany({
      where: { organizationId: membership.organizationId },
      select: { businessId: true },
    });
    return accounts.map(a => a.businessId);
  }

  /**
   * Get user's org role (null if not in an org).
   */
  async getUserOrgContext(userId: string): Promise<{
    organizationId: string;
    orgRole: string;
    accessibleAccountIds: string[];
  } | null> {
    const membership = await this.prisma.orgMembership.findFirst({ where: { userId } });
    if (!membership) return null;

    const accountIds = await this.getAccessibleAccountIds(userId);
    return {
      organizationId: membership.organizationId,
      orgRole: membership.role,
      accessibleAccountIds: accountIds,
    };
  }

  // ==========================================
  // Internal helpers
  // ==========================================

  private async requireOrgRole(userId: string, allowedRoles: string[]) {
    const membership = await this.prisma.orgMembership.findFirst({
      where: { userId },
      include: { organization: true },
    });
    if (!membership) throw new BadRequestException('You are not in an organization');
    if (!allowedRoles.includes(membership.role)) {
      throw new ForbiddenException(`Requires role: ${allowedRoles.join(' or ')}`);
    }
    return { org: membership.organization, myRole: membership.role };
  }
}
