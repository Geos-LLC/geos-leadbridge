import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MonitoringService } from './monitoring.service';
import { MonitoringController } from './monitoring.controller';

@Global() // Make MonitoringService available everywhere without explicit import
@Module({
  imports: [ConfigModule],
  controllers: [MonitoringController],
  providers: [MonitoringService],
  exports: [MonitoringService],
})
export class MonitoringModule {}
