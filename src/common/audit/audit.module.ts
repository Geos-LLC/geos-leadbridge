import { Global, Module } from '@nestjs/common';
import { PrismaService } from '../utils/prisma.service';
import { AuditService } from './audit.service';

/**
 * Global so the impersonation guard (registered as APP_GUARD in app.module.ts)
 * can inject AuditService without each consumer importing AuditModule.
 */
@Global()
@Module({
  providers: [AuditService, PrismaService],
  exports: [AuditService],
})
export class AuditModule {}
