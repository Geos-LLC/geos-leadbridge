import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IntegrationsService } from './integrations.service';
import { BudgetSnapshotDto } from './dto/budget-snapshot.dto';
import { CollectLeadsDto } from './dto/collect-leads.dto';
import { MarkImportedDto } from './dto/mark-imported.dto';

@Controller('integrations/thumbtack')
@UseGuards(JwtAuthGuard)
export class IntegrationsController {
  constructor(private integrationsService: IntegrationsService) {}

  /**
   * POST /api/integrations/thumbtack/snapshots/budget
   * Store a budget snapshot from the Chrome extension.
   */
  @Post('snapshots/budget')
  async saveBudgetSnapshot(
    @CurrentUser() user: any,
    @Body() dto: BudgetSnapshotDto,
  ) {
    return this.integrationsService.saveBudgetSnapshot(user.id, dto);
  }

  /**
   * POST /api/integrations/thumbtack/leads/collect
   * Collect lead/conversation IDs from the Chrome extension.
   */
  @Post('leads/collect')
  async collectLeadIds(
    @CurrentUser() user: any,
    @Body() dto: CollectLeadsDto,
  ) {
    return this.integrationsService.collectLeadIds(user.id, dto);
  }

  /**
   * GET /api/integrations/thumbtack/leads
   * Query collected lead IDs. Supports ?pending=true and ?refetch=true filters.
   */
  @Get('leads')
  async getLeadIds(
    @CurrentUser() user: any,
    @Query('pending') pending?: string,
    @Query('refetch') refetch?: string,
  ) {
    return this.integrationsService.getLeadIds(user.id, {
      pending: pending === 'true',
      refetch: refetch === 'true',
    });
  }

  /**
   * PATCH /api/integrations/thumbtack/leads/mark-imported
   * Mark specific lead IDs as imported into the main system.
   */
  @Patch('leads/mark-imported')
  async markLeadsImported(
    @CurrentUser() user: any,
    @Body() dto: MarkImportedDto,
  ) {
    return this.integrationsService.markLeadsImported(
      user.id,
      dto.thumbtackIds,
    );
  }
}
