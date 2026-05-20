import { Module } from '@nestjs/common';
import { PartnerNetworkService } from './partner-network.service';
import { PartnerNetworkController } from './partner-network.controller';
import { PartnerNetworkPublicController } from './partner-network-public.controller';
import { PrismaService } from '../../common/utils/prisma.service';

@Module({
  controllers: [PartnerNetworkController, PartnerNetworkPublicController],
  providers: [PartnerNetworkService, PrismaService],
  exports: [PartnerNetworkService],
})
export class PartnerNetworkModule {}
