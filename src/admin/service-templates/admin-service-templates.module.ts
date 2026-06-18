import { Module } from '@nestjs/common';
import { AdminServiceTemplatesController } from './admin-service-templates.controller';
import { AdminServiceTemplatesService } from './admin-service-templates.service';

/**
 * Admin Service Template Builder module.
 *
 * Exports `AdminServiceTemplatesService` so the existing
 * ServiceProfileModule can call `listPublished()` + `getPublishedById()`
 * when merging DB templates into the public preset picker.
 *
 * PrismaService comes via the global PrismaModule, so nothing to import.
 */
@Module({
  controllers: [AdminServiceTemplatesController],
  providers: [AdminServiceTemplatesService],
  exports: [AdminServiceTemplatesService],
})
export class AdminServiceTemplatesModule {}
