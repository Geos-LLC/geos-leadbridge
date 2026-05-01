import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../common/utils/prisma.service';
import { MonitoringService } from './monitoring.service';
import { MonitoringController } from './monitoring.controller';
import { PipelineIntegrityService } from './pipeline-integrity.service';

@Global() // Make MonitoringService available everywhere without explicit import
@Module({
  imports: [ConfigModule],
  controllers: [MonitoringController],
  providers: [PrismaService, MonitoringService, PipelineIntegrityService],
  exports: [MonitoringService, PipelineIntegrityService],
})
export class MonitoringModule {}
