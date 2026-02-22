import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { CallConnectService } from './call-connect.service';
import { CallConnectController } from './call-connect.controller';
import { PrismaService } from '../common/utils/prisma.service';

@Module({
  imports: [ConfigModule, HttpModule],
  controllers: [CallConnectController],
  providers: [CallConnectService, PrismaService],
  exports: [CallConnectService],
})
export class CallConnectModule {}
