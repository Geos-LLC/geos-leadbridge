import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ConversationSyncService } from './conversation-sync.service';
import { PrismaService } from '../common/utils/prisma.service';

@Controller('v1/conversation-sync')
export class ConversationSyncController {
  private readonly logger = new Logger(ConversationSyncController.name);

  constructor(
    private conversationSyncService: ConversationSyncService,
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {}

  /**
   * Get connection status for a saved account.
   */
  @Get('status/:savedAccountId')
  async getStatus(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    await this.verifyAccountOwnership(user.id, savedAccountId);
    const connection = await this.conversationSyncService.getConnection(user.id, savedAccountId);
    return {
      connected: connection?.status === 'ACTIVE',
      status: connection?.status || 'DISCONNECTED',
      provider: connection?.provider || null,
      connectedNumbers: connection?.connectedNumbers || [],
      lastError: connection?.lastError || null,
    };
  }

  /**
   * Connect OpenPhone for conversation sync.
   */
  @Post('connect/:savedAccountId')
  async connect(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
    @Body() body: { apiKey: string },
  ) {
    await this.verifyAccountOwnership(user.id, savedAccountId);

    if (!body.apiKey) {
      throw new HttpException('OpenPhone API key is required', HttpStatus.BAD_REQUEST);
    }

    const webhookBaseUrl = this.configService.get<string>('WEBHOOK_BASE_URL') ||
      this.configService.get<string>('API_URL') || '';

    const result = await this.conversationSyncService.connect(
      user.id,
      savedAccountId,
      body.apiKey,
      webhookBaseUrl,
    );

    if (!result.success) {
      throw new HttpException(result.error || 'Connection failed', HttpStatus.BAD_REQUEST);
    }

    return {
      success: true,
      phoneNumbers: result.phoneNumbers,
    };
  }

  /**
   * Disconnect OpenPhone.
   */
  @Delete('disconnect/:savedAccountId')
  async disconnect(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    await this.verifyAccountOwnership(user.id, savedAccountId);
    const result = await this.conversationSyncService.disconnect(user.id, savedAccountId);

    if (!result.success) {
      throw new HttpException(result.error || 'Disconnect failed', HttpStatus.BAD_REQUEST);
    }

    return { success: true };
  }

  /**
   * Refresh phone numbers.
   */
  @Post('numbers/:savedAccountId')
  async refreshNumbers(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    await this.verifyAccountOwnership(user.id, savedAccountId);
    const numbers = await this.conversationSyncService.refreshNumbers(user.id, savedAccountId);
    return { phoneNumbers: numbers };
  }

  /**
   * Step 1: Trigger OpenPhone → Sigcore sync (background, returns immediately).
   */
  @Post('sync-openphone/:savedAccountId')
  async syncOpenPhone(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    await this.verifyAccountOwnership(user.id, savedAccountId);
    const result = await this.conversationSyncService.triggerOpenPhoneSync(savedAccountId);

    if (!result.success) {
      throw new HttpException(result.error || 'Sync trigger failed', HttpStatus.BAD_REQUEST);
    }

    return { success: true };
  }

  /**
   * Get OpenPhone sync progress from Sigcore.
   */
  @Get('sync-status/:savedAccountId')
  async getSyncStatus(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    await this.verifyAccountOwnership(user.id, savedAccountId);
    return this.conversationSyncService.getSyncStatus(savedAccountId);
  }

  /**
   * Step 2: Match Sigcore conversations to LeadBridge leads by phone number.
   */
  @Post('match-leads/:savedAccountId')
  async matchLeads(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    await this.verifyAccountOwnership(user.id, savedAccountId);
    const result = await this.conversationSyncService.matchLeadConversations(
      user.id,
      savedAccountId,
    );

    return {
      success: !result.error,
      synced: result.synced,
      totalConversations: result.totalConversations,
      totalLeads: result.totalLeads,
      error: result.error,
    };
  }

  /**
   * Get SMS activity for a specific lead (messages from BYO phone conversations).
   */
  @Get('lead/:leadId/activity')
  async getLeadActivity(
    @CurrentUser() user: any,
    @Param('leadId') leadId: string,
  ) {
    // Verify lead ownership
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, userId: user.id },
      select: { id: true },
    });
    if (!lead) {
      throw new HttpException('Lead not found', HttpStatus.NOT_FOUND);
    }

    const messages = await this.conversationSyncService.getLeadSmsActivity(leadId);
    return { data: messages };
  }

  /**
   * Get all SMS conversations for a specific lead.
   */
  @Get('lead/:leadId/conversations')
  async getLeadConversations(
    @CurrentUser() user: any,
    @Param('leadId') leadId: string,
  ) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, userId: user.id },
      select: { id: true },
    });
    if (!lead) {
      throw new HttpException('Lead not found', HttpStatus.NOT_FOUND);
    }

    const conversations = await this.conversationSyncService.getLeadConversations(leadId);
    return { data: conversations };
  }

  // ==========================================
  // Helpers
  // ==========================================

  private async verifyAccountOwnership(userId: string, savedAccountId: string): Promise<void> {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId },
      select: { id: true },
    });
    if (!account) {
      throw new HttpException('Account not found', HttpStatus.NOT_FOUND);
    }
  }
}
