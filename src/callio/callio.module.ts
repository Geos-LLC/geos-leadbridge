import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { CallioService } from './callio.service';
import { PrismaService } from '../common/utils/prisma.service';

@Module({
  imports: [ConfigModule, HttpModule],
  providers: [CallioService, PrismaService],
  exports: [CallioService],
})
export class CallioModule {}
