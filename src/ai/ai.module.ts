import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { ConversationContextModule } from '../conversation-context/conversation-context.module';
import { PrismaService } from '../common/utils/prisma.service';

@Module({
  imports: [ConfigModule, ConversationContextModule],
  controllers: [AiController],
  providers: [AiService, PrismaService],
  exports: [AiService],
})
export class AiModule {}
