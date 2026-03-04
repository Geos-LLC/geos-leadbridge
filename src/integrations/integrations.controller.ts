import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Query,
  UseGuards,
  Logger,
  HttpCode,
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
  private readonly logger = new Logger(IntegrationsController.name);

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
    try {
      return await this.integrationsService.saveBudgetSnapshot(user.id, dto);
    } catch (err) {
      this.logger.error(`saveBudgetSnapshot failed for user ${user?.id}: ${err.message}`, err.stack);
      throw err;
    }
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
    try {
      return await this.integrationsService.collectLeadIds(user.id, dto);
    } catch (err) {
      this.logger.error(`collectLeadIds failed for user ${user?.id}: ${err.message}`, err.stack);
      throw err;
    }
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
    @Query('accountId') accountId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.integrationsService.getLeadIds(user.id, {
      pending: pending === 'true',
      refetch: refetch === 'true',
      savedAccountId: accountId,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  /**
   * GET /api/integrations/thumbtack/snapshots
   * Query budget snapshots for the authenticated user.
   */
  @Get('snapshots')
  async getSnapshots(
    @CurrentUser() user: any,
    @Query('accountId') accountId?: string,
  ) {
    return this.integrationsService.getSnapshots(user.id, accountId);
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

  /**
   * PATCH /api/integrations/thumbtack/leads/reset-imported
   * Reset lead IDs back to pending so they can be re-imported.
   * Pass thumbtackIds to reset specific ones, or omit to reset ALL imported leads for this user.
   */
  @Patch('leads/reset-imported')
  async resetImported(
    @CurrentUser() user: any,
    @Body() body: { thumbtackIds?: string[] },
  ) {
    return this.integrationsService.resetImported(user.id, body.thumbtackIds);
  }

  /**
   * POST /api/integrations/thumbtack/leads/reimport-failed
   * Re-import only leads that are marked imported but have no Lead record.
   */
  @Post('leads/reimport-failed')
  @HttpCode(200)
  async reimportFailed(
    @CurrentUser() user: any,
    @Body() body: { savedAccountId?: string },
  ) {
    return this.integrationsService.reimportFailed(user.id, body.savedAccountId);
  }

  /**
   * GET /api/integrations/thumbtack/leads/missing-count
   * Count how many collected leads have no matching Lead record (without importing).
   */
  @Get('leads/missing-count')
  async getMissingCount(
    @CurrentUser() user: any,
    @Query('accountId') accountId?: string,
  ) {
    return this.integrationsService.countMissingLeads(user.id, accountId);
  }

  /**
   * POST /api/integrations/thumbtack/leads/reimport
   * Server-side bulk re-import of all collected leads — no extension needed.
   * Pass savedAccountId in body to scope to a specific account.
   */
  @Post('leads/reimport')
  @HttpCode(200)
  async reimportLeads(
    @CurrentUser() user: any,
    @Body() body: { savedAccountId?: string },
  ) {
    return this.integrationsService.reimportLeads(user.id, body.savedAccountId);
  }

  /**
   * DELETE /api/integrations/thumbtack/leads
   * Delete collected lead IDs. Pass thumbtackIds in body, or omit to delete all.
   */
  @Delete('leads')
  async deleteLeadIds(
    @CurrentUser() user: any,
    @Body() body: { thumbtackIds?: string[]; savedAccountId?: string },
  ) {
    return this.integrationsService.deleteLeadIds(user.id, body.thumbtackIds, body.savedAccountId);
  }

  /**
   * DELETE /api/integrations/thumbtack/snapshots
   * Delete all budget snapshots for the authenticated user.
   */
  @Delete('snapshots')
  async deleteSnapshots(@CurrentUser() user: any) {
    return this.integrationsService.deleteSnapshots(user.id);
  }
}
