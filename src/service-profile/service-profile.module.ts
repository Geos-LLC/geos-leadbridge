import { Module } from '@nestjs/common';
import { ServiceProfileService } from './service-profile.service';

/**
 * ServiceProfileService is a read-side helper consumed by the AI
 * prompt assembler (ai.controller.ts) and — in future phases —
 * automation, notifications, and follow-up-generator.
 *
 * Provider-only module. No controllers in Phase 1 (no UI yet, no
 * external REST surface for profile CRUD).
 *
 * PrismaService comes through the global PrismaModule, so this stays
 * dependency-light.
 */
@Module({
  providers: [ServiceProfileService],
  exports: [ServiceProfileService],
})
export class ServiceProfileModule {}
