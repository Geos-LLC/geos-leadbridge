import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { IntentClassifierService } from './intent-classifier.service';
import { ConversationContextModule } from '../conversation-context/conversation-context.module';
import { ServiceProfileModule } from '../service-profile/service-profile.module';
import { PrismaService } from '../common/utils/prisma.service';

@Module({
  imports: [ConfigModule, ConversationContextModule, ServiceProfileModule],
  controllers: [AiController],
  providers: [AiService, IntentClassifierService, PrismaService],
  exports: [AiService, IntentClassifierService],
})
export class AiModule {}
