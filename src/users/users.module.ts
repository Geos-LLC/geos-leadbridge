import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PrismaService } from '../common/utils/prisma.service';
import { SigcoreModule } from '../sigcore/sigcore.module';

@Module({
  imports: [SigcoreModule],
  controllers: [UsersController],
  providers: [UsersService, PrismaService],
  exports: [UsersService],
})
export class UsersModule {}
