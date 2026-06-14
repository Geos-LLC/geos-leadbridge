import { Module } from '@nestjs/common';
import { ServiceSchemaService } from './service-schema.service';
import { ServiceSchemaController } from './service-schema.controller';

/**
 * Service Schema accumulator + read API.
 *
 * Exports ServiceSchemaService so WebhooksModule + scripts can inject it.
 * PrismaService comes through the global PrismaModule — no extra import
 * needed here.
 */
@Module({
  controllers: [ServiceSchemaController],
  providers: [ServiceSchemaService],
  exports: [ServiceSchemaService],
})
export class ServiceSchemaModule {}
