/**
 * Leads Module
 */

import { Module } from '@nestjs/common';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { PrismaService } from '../common/utils/prisma.service';
import { PlatformsModule } from '../platforms/platforms.module';

@Module({
  imports: [PlatformsModule],
  controllers: [LeadsController],
  providers: [LeadsService, PrismaService],
  exports: [LeadsService],
})
export class LeadsModule {}
