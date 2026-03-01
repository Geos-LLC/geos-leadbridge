import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { SigcoreService } from './sigcore.service';

@Module({
  imports: [ConfigModule, HttpModule],
  providers: [SigcoreService],
  exports: [SigcoreService],
})
export class SigcoreModule {}
