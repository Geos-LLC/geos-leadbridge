import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { SigcoreService } from './sigcore.service';
import { PrismaService } from '../common/utils/prisma.service';

@Module({
  imports: [ConfigModule, HttpModule],
  providers: [SigcoreService, PrismaService],
  exports: [SigcoreService],
})
export class SigcoreModule {}
