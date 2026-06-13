import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../common/utils/prisma.module';
import { AiSettingsAssistantController } from './assistant.controller';
import { AiSettingsAssistantService } from './assistant.service';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [AiSettingsAssistantController],
  providers: [AiSettingsAssistantService],
  exports: [AiSettingsAssistantService],
})
export class AiSettingsAssistantModule {}
