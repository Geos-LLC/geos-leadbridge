/**
 * Teams Controller
 *
 * REST endpoints for team/organization management.
 * All endpoints require JWT auth. Role checks in service layer.
 */

import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TeamsService } from './teams.service';

@Controller('v1/teams')
@UseGuards(JwtAuthGuard)
export class TeamsController {
  constructor(private readonly teamsService: TeamsService) {}

  /** Create a new organization */
  @Post()
  async createOrg(@CurrentUser() user: any, @Body('name') name: string) {
    const org = await this.teamsService.createOrg(user.id, name);
    return { success: true, organization: org };
  }

  /** Get my organization + members + pending invitations */
  @Get('my-org')
  async getMyOrg(@CurrentUser() user: any) {
    const result = await this.teamsService.getMyOrg(user.id);
    if (!result) return { success: true, organization: null, myRole: null };
    return { success: true, ...result };
  }

  /** Invite a user by email */
  @Post('invite')
  async invite(
    @CurrentUser() user: any,
    @Body('email') email: string,
    @Body('role') role?: 'ADMIN' | 'MEMBER',
  ) {
    const result = await this.teamsService.invite(user.id, email, role || 'MEMBER');
    return { success: true, ...result };
  }

  /** Accept an invitation by token */
  @Post('invite/accept')
  async acceptInvite(@CurrentUser() user: any, @Body('token') token: string) {
    const result = await this.teamsService.acceptInvite(user.id, token);
    return { success: true, ...result };
  }

  /** Remove a member */
  @Delete('members/:userId')
  async removeMember(@CurrentUser() user: any, @Param('userId') targetUserId: string) {
    return this.teamsService.removeMember(user.id, targetUserId);
  }

  /** Update a member's role */
  @Patch('members/:userId/role')
  async updateRole(
    @CurrentUser() user: any,
    @Param('userId') targetUserId: string,
    @Body('role') role: 'ADMIN' | 'MEMBER',
  ) {
    return this.teamsService.updateRole(user.id, targetUserId, role);
  }

  /** List pending invitations */
  @Get('invitations')
  async getInvitations(@CurrentUser() user: any) {
    const result = await this.teamsService.getMyOrg(user.id);
    return { success: true, invitations: result?.organization?.invitations || [] };
  }

  /** Revoke a pending invitation */
  @Delete('invitations/:id')
  async revokeInvitation(@CurrentUser() user: any, @Param('id') invitationId: string) {
    return this.teamsService.revokeInvitation(user.id, invitationId);
  }

  /** Leave organization (non-owner) */
  @Post('leave')
  async leaveOrg(@CurrentUser() user: any) {
    return this.teamsService.leaveOrg(user.id);
  }

  /** Delete organization (owner only) */
  @Delete()
  async deleteOrg(@CurrentUser() user: any) {
    return this.teamsService.deleteOrg(user.id);
  }
}
