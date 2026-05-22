import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PartnerNetworkService } from './partner-network.service';
import { PartnerNetworkController } from './partner-network.controller';
import { PartnerNetworkPublicController } from './partner-network-public.controller';
import { PrismaService } from '../../common/utils/prisma.service';

@Module({
  // ConfigModule provides OPENAI_API_KEY to the in-service OpenAI client.
  // Kept inline (vs. depending on AiModule) so this module stays portable
  // — only env config is required to extract it later.
  imports: [ConfigModule],
  controllers: [PartnerNetworkController, PartnerNetworkPublicController],
  providers: [PartnerNetworkService, PrismaService],
  exports: [PartnerNetworkService],
})
export class PartnerNetworkModule {}
