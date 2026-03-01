import { Module } from '@nestjs/common';
import { TestController } from './test.controller';
import { TestService } from './test.service';
import { WebhooksModule } from '../webhooks/webhooks.module';
@Module({
  imports: [WebhooksModule],
  controllers: [TestController],
  providers: [TestService],
})
export class TestModule {}
