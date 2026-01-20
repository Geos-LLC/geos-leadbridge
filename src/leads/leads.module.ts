/**
 * Leads Module
 */

import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { PrismaService } from '../common/utils/prisma.service';
import { PlatformsModule } from '../platforms/platforms.module';

@Module({
  imports: [forwardRef(() => PlatformsModule), ConfigModule],
  controllers: [LeadsController],
  providers: [LeadsService, PrismaService],
  exports: [LeadsService],
})
export class LeadsModule {}
