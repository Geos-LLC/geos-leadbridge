import { Module } from '@nestjs/common';
import { PrismaService } from '../utils/prisma.service';
import { TenancyService } from './tenancy.service';

@Module({
  providers: [TenancyService, PrismaService],
  exports: [TenancyService],
})
export class TenancyModule {}
