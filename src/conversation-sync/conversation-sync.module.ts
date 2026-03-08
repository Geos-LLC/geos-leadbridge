import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ConversationSyncController } from './conversation-sync.controller';
import { ConversationSyncService } from './conversation-sync.service';

@Module({
  imports: [ConfigModule],
  controllers: [ConversationSyncController],
  providers: [ConversationSyncService],
  exports: [ConversationSyncService],
})
export class ConversationSyncModule {}
