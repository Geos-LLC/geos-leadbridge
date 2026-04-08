/**
 * CRM Webhook Module
 *
 * Outbound webhook subscriptions for external CRM integrations.
 * Provides CrmWebhookService for emitting normalized events.
 */

import { Module, Global } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { CrmWebhookService } from './crm-webhook.service';
import { CrmWebhookController } from './crm-webhook.controller';

@Global() // Global so any service can emit without importing the module
@Module({
  providers: [PrismaService, CrmWebhookService],
  controllers: [CrmWebhookController],
  exports: [CrmWebhookService],
})
export class CrmWebhookModule {}
