/**
 * Follow-Up Engine Module
 *
 * Sequence-based follow-up system, separate from conversation context.
 * Reads ThreadContext (source of truth), writes to its own tables.
 * Yelp v1, extensible to Thumbtack via platform field.
 */

import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaService } from '../common/utils/prisma.service';
import { ConversationContextModule } from '../conversation-context/conversation-context.module';
import { LeadsModule } from '../leads/leads.module';
import { FollowUpEngineService } from './follow-up-engine.service';
import { FollowUpStateService } from './follow-up-state.service';
import { FollowUpSchedulerService } from './follow-up-scheduler.service';
import { FollowUpGeneratorService } from './follow-up-generator.service';
import { FollowUpMigrationService } from './follow-up-migration.service';
import { FollowUpEngineController } from './follow-up-engine.controller';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    ConversationContextModule,
    forwardRef(() => LeadsModule),
  ],
  providers: [
    PrismaService,
    FollowUpEngineService,
    FollowUpStateService,
    FollowUpSchedulerService,
    FollowUpGeneratorService,
    FollowUpMigrationService,
  ],
  controllers: [FollowUpEngineController],
  exports: [FollowUpEngineService, FollowUpStateService],
})
export class FollowUpEngineModule {}
