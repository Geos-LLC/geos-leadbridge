/**
 * Conversation Context Module
 *
 * Intelligence layer for per-thread conversation memory.
 * Owns: ThreadContext table, context building, summary/state updates.
 * Reads from: Conversation + Message tables (operational data).
 *
 * Designed for future extraction to Behavior IQ service
 * (cross-thread, cross-channel intelligence).
 */

import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../common/utils/prisma.service';
import { TenancyModule } from '../common/tenancy/tenancy.module';
import { ConversationContextService } from './conversation-context.service';
import { ConversationContextController } from './conversation-context.controller';
import { ConversationRuntimeService } from './conversation-runtime.service';

@Module({
  imports: [ConfigModule, TenancyModule],
  providers: [ConversationContextService, ConversationRuntimeService, PrismaService],
  controllers: [ConversationContextController],
  exports: [ConversationContextService, ConversationRuntimeService],
})
export class ConversationContextModule {}
