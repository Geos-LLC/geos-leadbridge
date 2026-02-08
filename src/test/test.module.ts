import { Module } from '@nestjs/common';
import { TestController } from './test.controller';
import { TestService } from './test.service';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { PrismaService } from '../common/utils/prisma.service';

@Module({
  imports: [WebhooksModule],
  controllers: [TestController],
  providers: [TestService, PrismaService],
})
export class TestModule {}
