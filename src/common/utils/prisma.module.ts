import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { BusinessHoursService } from './business-hours.service';

@Global()
@Module({
  providers: [PrismaService, BusinessHoursService],
  exports: [PrismaService, BusinessHoursService],
})
export class PrismaModule {}
