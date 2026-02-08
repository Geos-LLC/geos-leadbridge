import { Controller, Post, Get, Body, Param, UseGuards, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AdminGuard } from '../admin/guards/admin.guard';
import { TestService, SimulateWebhookDto } from './test.service';

@Controller('v1/test')
@UseGuards(AdminGuard)
export class TestController {
  constructor(private testService: TestService) {}

  @Get('users')
  async getUsers(@Query('search') search?: string) {
    return this.testService.getUsers(search);
  }

  @Get('users/:userId/accounts')
  async getUserAccounts(@Param('userId') userId: string) {
    return this.testService.getUserAccounts(userId);
  }

  @Post('simulate')
  async simulateWebhook(
    @Body() body: SimulateWebhookDto,
  ) {
    return this.testService.simulateWebhook(body.targetUserId, body);
  }

  @Get('diagnostics/:savedAccountId')
  async getAccountDiagnostics(
    @Param('savedAccountId') savedAccountId: string,
  ) {
    return this.testService.getAccountDiagnostics(savedAccountId);
  }

  @Get('leads/:savedAccountId')
  async getLeadsForAccount(
    @Query('userId') userId: string,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    return this.testService.getLeadsForAccount(userId, savedAccountId);
  }
}
