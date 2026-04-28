import { Global, Module } from '@nestjs/common';
import { PrismaService } from '../../common/utils/prisma.service';
import { SupportGrantsController } from './support-grants.controller';
import { SupportGrantsService } from './support-grants.service';
import { SupportGrantGuard } from './guards/support-grant.guard';

/**
 * @Global so SupportGrantGuard (used as a route-level guard via the
 * @RequiresSupportGrant() decorator) can be instantiated by Nest's DI
 * anywhere without each consumer module having to import this module.
 */
@Global()
@Module({
  providers: [SupportGrantsService, SupportGrantGuard, PrismaService],
  controllers: [SupportGrantsController],
  exports: [SupportGrantsService, SupportGrantGuard],
})
export class SupportGrantsModule {}
