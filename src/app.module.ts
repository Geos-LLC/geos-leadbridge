/**
 * Main Application Module
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { AuthModule } from './auth/auth.module';
import { PlatformsModule } from './platforms/platforms.module';
import { LeadsModule } from './leads/leads.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { TemplatesModule } from './templates/templates.module';
import { AutomationModule } from './automation/automation.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { StripeModule } from './stripe/stripe.module';
import { AdminModule } from './admin/admin.module';
import { SigcoreModule } from './sigcore/sigcore.module';
import { UsersModule } from './users/users.module';
import { TestModule } from './test/test.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { CallConnectModule } from './call-connect/call-connect.module';
import { ConversationSyncModule } from './conversation-sync/conversation-sync.module';
import { ConversationContextModule } from './conversation-context/conversation-context.module';
import { FollowUpEngineModule } from './follow-up-engine/follow-up-engine.module';
import { TeamsModule } from './teams/teams.module';
import { CrmWebhookModule } from './crm-webhooks/crm-webhook.module';
import { ServiceFlowModule } from './integrations/service-flow/service-flow.module';
import { HealthModule } from './health/health.module';
import { IntegrationsHealthModule } from './integrations/health/integrations-health.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { TrialModule } from './trial/trial.module';
import { PartnerNetworkModule } from './modules/partner-network/partner-network.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { ImpersonationGuard, ImpersonationInterceptor } from './common/guards/impersonation.guard';
import { PrismaModule } from './common/utils/prisma.module';
import { CacheModule } from './common/cache/cache.module';
import { AuditModule } from './common/audit/audit.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    // Wildcards are required for dynamic event names like `lead.created.${userId}`.
    // `.` is the delimiter. Existing exact-match listeners (e.g. 'trial.ended') are unaffected.
    EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
    ScheduleModule.forRoot(),
    PrismaModule,
    CacheModule,
    AuditModule,
    TrialModule,
    AuthModule,
    PlatformsModule,
    LeadsModule,
    WebhooksModule,
    TemplatesModule,
    AutomationModule,
    NotificationsModule,
    AnalyticsModule,
    StripeModule,
    AdminModule,
    SigcoreModule,
    UsersModule,
    TestModule,
    IntegrationsModule,
    CallConnectModule,
    ConversationSyncModule,
    ConversationContextModule,
    FollowUpEngineModule,
    TeamsModule,
    CrmWebhookModule,
    ServiceFlowModule,
    HealthModule,
    IntegrationsHealthModule,
    MonitoringModule,
    OnboardingModule,
    PartnerNetworkModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ImpersonationGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ImpersonationInterceptor,
    },
  ],
})
export class AppModule {}
