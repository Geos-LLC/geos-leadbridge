/**
 * CRM Webhook Controller
 *
 * CRUD endpoints for outbound webhook subscriptions.
 * Used by ServiceFlow (and future CRMs) to register for real-time events.
 */

import { Controller, Get, Post, Delete, Param, Body, UseGuards, Logger } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../common/utils/prisma.service';
import { CrmWebhookService } from './crm-webhook.service';
import * as crypto from 'crypto';

@Controller('v1/integrations/webhooks')
@UseGuards(JwtAuthGuard)
export class CrmWebhookController {
  private readonly logger = new Logger(CrmWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crmWebhookService: CrmWebhookService,
  ) {}

  /**
   * Create a new webhook subscription.
   */
  @Post()
  async create(
    @CurrentUser() user: any,
    @Body() body: { name: string; webhookUrl: string; events: string[]; secret?: string; metadata?: any },
  ) {
    const secret = body.secret || crypto.randomBytes(32).toString('hex');

    const subscription = await this.prisma.crmWebhookSubscription.upsert({
      where: {
        userId_direction_webhookUrl: {
          userId: user.id,
          direction: 'outbound',
          webhookUrl: body.webhookUrl,
        },
      },
      create: {
        userId: user.id,
        name: body.name,
        webhookUrl: body.webhookUrl,
        secret,
        events: body.events,
        metadata: body.metadata,
        direction: 'outbound',
      },
      update: {
        name: body.name,
        events: body.events,
        secret,
        isActive: true,
        metadata: body.metadata,
      },
    });

    this.logger.log(`[CrmWebhook] Subscription created/updated: ${subscription.name} → ${subscription.webhookUrl}`);

    return {
      success: true,
      subscription: {
        id: subscription.id,
        name: subscription.name,
        webhookUrl: subscription.webhookUrl,
        events: subscription.events,
        isActive: subscription.isActive,
        secret, // Return secret on creation so the caller can store it
      },
    };
  }

  /**
   * List all webhook subscriptions for the current user.
   */
  @Get()
  async list(@CurrentUser() user: any) {
    const subscriptions = await this.prisma.crmWebhookSubscription.findMany({
      where: { userId: user.id, direction: 'outbound' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        webhookUrl: true,
        events: true,
        isActive: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return { success: true, count: subscriptions.length, subscriptions };
  }

  /**
   * Delete (deactivate) a webhook subscription.
   */
  @Delete(':id')
  async remove(@CurrentUser() user: any, @Param('id') id: string) {
    const sub = await this.prisma.crmWebhookSubscription.findFirst({
      where: { id, userId: user.id },
    });
    if (!sub) return { success: false, error: 'Subscription not found' };

    await this.prisma.crmWebhookSubscription.delete({ where: { id } });
    this.logger.log(`[CrmWebhook] Subscription deleted: ${sub.name}`);
    return { success: true };
  }

  /**
   * Send a test event to verify webhook connectivity.
   */
  @Post(':id/test')
  async test(@CurrentUser() user: any, @Param('id') id: string) {
    const result = await this.crmWebhookService.sendTestEvent(id, user.id);
    return result;
  }
}
