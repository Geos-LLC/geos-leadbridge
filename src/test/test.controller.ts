import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TestService, SimulateWebhookDto } from './test.service';

@Controller('v1/test')
export class TestController {
  constructor(private testService: TestService) {}

  @Post('simulate')
  async simulateWebhook(
    @CurrentUser() user: any,
    @Body() body: SimulateWebhookDto,
  ) {
    return this.testService.simulateWebhook(user.id, body);
  }

  @Get('leads/:savedAccountId')
  async getLeadsForAccount(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    return this.testService.getLeadsForAccount(user.id, savedAccountId);
  }
}
