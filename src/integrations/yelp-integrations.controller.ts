/**
 * Yelp Integrations Controller
 *
 * Backend endpoints for the LeadBridge Sync - Yelp Chrome extension.
 * Receives scraped lead IDs from biz.yelp.com inbox, fetches lead details
 * from Yelp API, and creates leads in the database.
 */

import { Controller, Post, Get, Body, Query, UseGuards, Logger, Inject, Optional, forwardRef } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../common/utils/prisma.service';
import { PlatformService } from '../platforms/platform.service';
import { PlatformFactory } from '../platforms/platform.factory';
import { EncryptionUtil } from '../common/utils/encryption.util';
import { ConfigService } from '@nestjs/config';
import { FollowUpEngineService } from '../follow-up-engine/follow-up-engine.service';

@Controller('v1/integrations/yelp')
@UseGuards(JwtAuthGuard)
export class YelpIntegrationsController {
  private readonly logger = new Logger(YelpIntegrationsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformService: PlatformService,
    private readonly platformFactory: PlatformFactory,
    private readonly configService: ConfigService,
    @Optional()
    @Inject(forwardRef(() => FollowUpEngineService))
    private readonly followUpEngine: FollowUpEngineService | null,
  ) {}

  /**
   * POST /v1/integrations/yelp/leads/collect
   * Receive scraped lead IDs from the Chrome extension.
   * For each new lead ID, fetch details from Yelp API and create in DB.
   */
  @Post('leads/collect')
  async collectLeads(
    @CurrentUser() user: any,
    @Body() body: {
      savedAccountId: string;
      businessId: string;
      leadIds: string[];
      leadNames?: Record<string, string>;
      leadDates?: Record<string, string>;
      leadCategories?: Record<string, string>;
      leadLocations?: Record<string, string>;
      leadStatuses?: Record<string, string>;
      source?: string;
    },
  ) {
    const { savedAccountId, businessId, leadIds, leadNames, leadDates, leadCategories, leadLocations, leadStatuses } = body;
    this.logger.log(`[Yelp Import] Received ${leadIds.length} lead IDs for business ${businessId}`);

    // Get credentials for this account
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId: user.id, platform: 'yelp' },
    });
    if (!account?.credentialsJson) {
      return { ok: false, error: 'Yelp account not found or not connected' };
    }

    const encryptionKey = this.configService.get<string>('encryption.key') || '';
    const creds = EncryptionUtil.decryptObject<any>(account.credentialsJson, encryptionKey);
    const yelpAdapter = this.platformFactory.getAdapter('yelp') as any;

    let imported = 0;
    let skipped = 0;
    let failed = 0;

    for (const leadId of leadIds) {
      // Check if already exists
      const existing = await this.prisma.lead.findUnique({
        where: { platform_externalRequestId: { platform: 'yelp', externalRequestId: leadId } },
      });
      if (existing) {
        // Check if anything changed
        const newName = leadNames?.[leadId];
        const newCategory = leadCategories?.[leadId];
        const newStatusRaw = leadStatuses?.[leadId];
        const newStatus = newStatusRaw?.toLowerCase();
        const newLocation = leadLocations?.[leadId];

        const nameChanged = newName && existing.customerName !== newName && (existing.customerName === 'Unknown' || newName !== 'Unknown');
        const statusChanged = newStatus && existing.status !== newStatus;
        // Platform-native status lives in its own column. Post-rollout plan:
        // SF writes Lead.status, platform writes Lead.platformStatus. During
        // rollout (SF_STATUS_WINS=false) we still write both for backward compat.
        const platformStatusChanged = newStatusRaw && existing.platformStatus !== newStatusRaw;
        const categoryChanged = newCategory && existing.category !== newCategory && !existing.category;
        const locationChanged = newLocation && !existing.city;

        const sfWins = this.configService.get<string>('SF_STATUS_WINS', 'false') === 'true';
        // If SF is the authority and this lead is SF-mapped, do NOT overwrite lead.status
        // from platform. Platform still writes platformStatus.
        const skipLeadStatusWrite = sfWins && existing.sfJobId !== null && existing.sfJobId !== undefined;

        if (nameChanged || statusChanged || categoryChanged || locationChanged || platformStatusChanged) {
          const updates: any = {};
          if (nameChanged) updates.customerName = newName;
          if (statusChanged && !skipLeadStatusWrite) {
            updates.status = newStatus;
            updates.statusSource = 'platform_sync';
            updates.statusUpdatedAt = new Date();
          }
          if (platformStatusChanged) {
            updates.platformStatus = newStatusRaw;
            updates.platformStatusAt = new Date();
          }
          if (categoryChanged) updates.category = newCategory;
          if (locationChanged) {
            updates.city = newLocation.split(',')[0]?.trim();
            updates.state = newLocation.split(',')[1]?.trim()?.split(' ')[0];
            updates.postcode = newLocation.match(/\d{5}/)?.[0];
          }

          await this.prisma.lead.update({ where: { id: existing.id }, data: updates });

          // Also update conversation name if changed
          if (nameChanged && existing.threadId) {
            await this.prisma.conversation.update({
              where: { id: existing.threadId },
              data: { customerName: newName },
            }).catch(() => {});
          }

          // Trigger engagement-aware re-evaluation when the platform signal
          // is one we care about (Not hired / Archived / Hired / Active).
          // Only fire on transitions — skip no-op.
          if (platformStatusChanged && existing.threadId && this.followUpEngine) {
            const signal = newStatusRaw || '';
            const relevant = /^(not hired|archived|hired|active)$/i.test(signal);
            if (relevant) {
              this.followUpEngine.handlePlatformSignal(existing.threadId, signal)
                .then(action => {
                  if (action !== 'no_change' && action !== 'no_enrollment') {
                    this.logger.log(`[Yelp Import] Platform signal "${signal}" on lead ${leadId} → ${action}`);
                  }
                })
                .catch(err => this.logger.warn(`[Yelp Import] handlePlatformSignal failed: ${err.message}`));
            }
          }

          imported++;
          this.logger.log(`[Yelp Import] Updated lead ${leadId}: ${Object.keys(updates).join(', ')}`);
        } else {
          skipped++;
        }
        continue;
      }

      // Fetch lead details from Yelp API
      try {
        const leadData = await yelpAdapter.getLead({ accessToken: creds.accessToken }, leadId);

        // Create conversation
        const conversation = await this.prisma.conversation.upsert({
          where: { platform_externalThreadId: { platform: 'yelp', externalThreadId: leadId } },
          create: {
            userId: user.id,
            platform: 'yelp',
            externalThreadId: leadId,
            customerName: leadData.customerName || leadNames?.[leadId] || 'Unknown',
            lastMessageAt: leadData.createdAt || new Date(),
            status: 'active',
          },
          update: { lastMessageAt: new Date() },
        });

        // Create lead
        await this.prisma.lead.create({
          data: {
            userId: user.id,
            platform: 'yelp',
            businessId: businessId || account.businessId,
            externalRequestId: leadId,
            threadId: conversation.id,
            customerName: leadData.customerName || leadNames?.[leadId] || 'Unknown',
            customerPhone: leadData.customerPhone,
            customerEmail: leadData.customerEmail,
            message: leadData.message,
            city: leadData.city,
            state: leadData.state,
            postcode: leadData.postcode,
            category: leadData.category || leadCategories?.[leadId],
            status: leadData.status || 'new',
            rawJson: JSON.stringify(leadData.raw || {}),
          },
        });

        imported++;
        this.logger.log(`[Yelp Import] Imported lead ${leadId}: ${leadData.customerName}`);
      } catch (err: any) {
        // If API fails, create minimal lead from scraped metadata
        const is401 = err.message?.includes('401') || err.response?.status === 401;
        if (is401) {
          this.logger.warn(`[Yelp Import] 401 for lead ${leadId} — creating from scraped data`);
        } else {
          this.logger.warn(`[Yelp Import] Failed to fetch lead ${leadId}: ${err.message} — creating from scraped data`);
        }

        try {
          const scrapedName = leadNames?.[leadId] || 'Unknown';
          const conversation = await this.prisma.conversation.upsert({
            where: { platform_externalThreadId: { platform: 'yelp', externalThreadId: leadId } },
            create: {
              userId: user.id,
              platform: 'yelp',
              externalThreadId: leadId,
              customerName: scrapedName,
              lastMessageAt: new Date(),
              status: 'active',
            },
            update: { customerName: scrapedName !== 'Unknown' ? scrapedName : undefined },
          });

          await this.prisma.lead.create({
            data: {
              userId: user.id,
              platform: 'yelp',
              businessId: businessId || account.businessId,
              externalRequestId: leadId,
              threadId: conversation.id,
              customerName: leadNames?.[leadId] || 'Unknown',
              message: '',
              category: leadCategories?.[leadId],
              city: leadLocations?.[leadId]?.split(',')[0]?.trim(),
              state: leadLocations?.[leadId]?.split(',')[1]?.trim()?.split(' ')[0],
              postcode: leadLocations?.[leadId]?.match(/\d{5}/)?.[0],
              status: leadStatuses?.[leadId]?.toLowerCase() || 'new',
              rawJson: JSON.stringify({ scraped: true, source: 'extension', location: leadLocations?.[leadId], date: leadDates?.[leadId] }),
            },
          });
          imported++;
        } catch (createErr: any) {
          failed++;
          this.logger.error(`[Yelp Import] Failed to create lead ${leadId}: ${createErr.message}`);
        }
      }
    }

    this.logger.log(`[Yelp Import] Done: ${imported} imported, ${skipped} skipped, ${failed} failed`);
    return { ok: true, imported, skipped, failed, total: leadIds.length };
  }

  /**
   * GET /v1/integrations/yelp/leads
   * Get existing Yelp leads for comparison (used by extension to detect new vs existing).
   */
  @Get('leads')
  async getLeads(
    @CurrentUser() user: any,
    @Query('accountId') accountId?: string,
  ) {
    const where: any = { userId: user.id, platform: 'yelp' };
    if (accountId) {
      const account = await this.prisma.savedAccount.findFirst({
        where: { id: accountId, userId: user.id },
        select: { businessId: true },
      });
      if (account) where.businessId = account.businessId;
    }

    const leads = await this.prisma.lead.findMany({
      where,
      select: { id: true, externalRequestId: true, customerName: true, status: true },
      orderBy: { createdAt: 'desc' },
    });

    return {
      ok: true,
      leads: leads.map(l => ({
        yelpLeadId: l.externalRequestId,
        name: l.customerName,
        status: l.status,
      })),
    };
  }
}
