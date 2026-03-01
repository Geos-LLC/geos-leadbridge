import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { CallConnectService } from './call-connect.service';
import { CallConnectController } from './call-connect.controller';
@Module({
  imports: [ConfigModule, HttpModule],
  controllers: [CallConnectController],
  providers: [CallConnectService],
  exports: [CallConnectService],
})
export class CallConnectModule {}
