import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { TenancyModule } from '../common/tenancy/tenancy.module';
import { CallConnectService } from './call-connect.service';
import { CallConnectController } from './call-connect.controller';
@Module({
  imports: [ConfigModule, HttpModule, TenancyModule],
  controllers: [CallConnectController],
  providers: [CallConnectService],
  exports: [CallConnectService],
})
export class CallConnectModule {}
