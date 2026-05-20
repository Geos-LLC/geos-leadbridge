/**
 * Partner Network Admin Controllers
 *
 * Admin-only REST endpoints. Public submit / view-by-code lives in
 * PartnerNetworkPublicController.
 *
 * workspaceId is the authenticated user's id for the MVP. When the module
 * goes multi-user-per-tenant, swap `user.id` for the resolved organization
 * id — controllers don't need to change beyond that.
 */

import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PartnerNetworkService } from './partner-network.service';
import {
  CreatePartnerBusinessDto,
  UpdatePartnerBusinessDto,
} from './dto/business.dto';
import {
  CreatePartnerRelationshipDto,
  UpdatePartnerRelationshipDto,
} from './dto/relationship.dto';
import {
  CreatePartnerReferralCodeDto,
  UpdatePartnerReferralCodeDto,
} from './dto/referral-code.dto';
import { UpdatePartnerLeadDto } from './dto/lead.dto';
import { PartnerLeadIntent, PartnerLeadStatus } from '../../../generated/prisma';

@Controller('partner-network')
@UseGuards(JwtAuthGuard)
export class PartnerNetworkController {
  constructor(private readonly service: PartnerNetworkService) {}

  // ===== Businesses =====
  @Get('businesses')
  async listBusinesses(@CurrentUser() user: any) {
    return { success: true, businesses: await this.service.listBusinesses(user.id) };
  }

  @Post('businesses')
  async createBusiness(@CurrentUser() user: any, @Body() body: CreatePartnerBusinessDto) {
    return { success: true, business: await this.service.createBusiness(user.id, body) };
  }

  @Patch('businesses/:id')
  async updateBusiness(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: UpdatePartnerBusinessDto,
  ) {
    return { success: true, business: await this.service.updateBusiness(user.id, id, body) };
  }

  // ===== Relationships =====
  @Get('relationships')
  async listRelationships(@CurrentUser() user: any) {
    return { success: true, relationships: await this.service.listRelationships(user.id) };
  }

  @Post('relationships')
  async createRelationship(
    @CurrentUser() user: any,
    @Body() body: CreatePartnerRelationshipDto,
  ) {
    return {
      success: true,
      relationship: await this.service.createRelationship(user.id, body),
    };
  }

  @Patch('relationships/:id')
  async updateRelationship(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: UpdatePartnerRelationshipDto,
  ) {
    return {
      success: true,
      relationship: await this.service.updateRelationship(user.id, id, body),
    };
  }

  // ===== Referral codes =====
  @Get('referral-codes')
  async listReferralCodes(@CurrentUser() user: any) {
    return {
      success: true,
      referralCodes: await this.service.listReferralCodes(user.id),
    };
  }

  @Post('referral-codes')
  async createReferralCode(
    @CurrentUser() user: any,
    @Body() body: CreatePartnerReferralCodeDto,
  ) {
    return {
      success: true,
      referralCode: await this.service.createReferralCode(user.id, body),
    };
  }

  @Patch('referral-codes/:id')
  async updateReferralCode(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: UpdatePartnerReferralCodeDto,
  ) {
    return {
      success: true,
      referralCode: await this.service.updateReferralCode(user.id, id, body),
    };
  }

  // ===== Leads =====
  @Get('leads')
  async listLeads(
    @CurrentUser() user: any,
    @Query('sourceBusinessId') sourceBusinessId?: string,
    @Query('destinationBusinessId') destinationBusinessId?: string,
    @Query('referralCodeId') referralCodeId?: string,
    @Query('status') status?: PartnerLeadStatus,
    @Query('intentTiming') intentTiming?: PartnerLeadIntent,
  ) {
    const leads = await this.service.listLeads(user.id, {
      sourceBusinessId,
      destinationBusinessId,
      referralCodeId,
      status,
      intentTiming,
    });
    return { success: true, leads };
  }

  @Patch('leads/:id')
  async updateLead(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: UpdatePartnerLeadDto,
  ) {
    return { success: true, lead: await this.service.updateLead(user.id, id, body) };
  }

  @Get('leads.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportLeadsCsv(@CurrentUser() user: any, @Res() res: Response) {
    const csv = await this.service.exportLeadsCsv(user.id);
    const filename = `partner-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }

  // ===== Dashboard =====
  @Get('dashboard')
  async dashboard(@CurrentUser() user: any) {
    return { success: true, ...(await this.service.getDashboard(user.id)) };
  }
}
