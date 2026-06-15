import { Module } from '@nestjs/common';
import { ServiceProfileService } from './service-profile.service';
import { ServiceProfileController } from './service-profile.controller';

/**
 * ServiceProfileService is a read-side helper consumed by the AI
 * prompt assembler (ai.controller.ts), automation, follow-up
 * generator, and instant-text-ai (Phase 1b).
 *
 * v1 preset consumer adds the controller for the two REST endpoints:
 *   GET  /v1/service-profile-presets       — list curated registry
 *   POST /v1/service-profiles/from-preset  — create a draft profile
 *
 * PrismaService comes through the global PrismaModule, so this stays
 * dependency-light.
 */
@Module({
  controllers: [ServiceProfileController],
  providers: [ServiceProfileService],
  exports: [ServiceProfileService],
})
export class ServiceProfileModule {}
