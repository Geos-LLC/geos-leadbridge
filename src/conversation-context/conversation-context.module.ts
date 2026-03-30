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
import { ConversationContextService } from './conversation-context.service';
import { ConversationContextController } from './conversation-context.controller';

@Module({
  imports: [ConfigModule],
  providers: [ConversationContextService, PrismaService],
  controllers: [ConversationContextController],
  exports: [ConversationContextService],
})
export class ConversationContextModule {}
