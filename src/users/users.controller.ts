import { Controller, Get, Post, Query, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsersService } from './users.service';
import { SigcoreSearchResult } from '../sigcore/sigcore.service';

@Controller('v1/users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private usersService: UsersService) {}

  /**
   * Get current user's phone number
   * GET /v1/users/me/phone-number
   */
  @Get('me/phone-number')
  async getMyPhoneNumber(@Request() req: any) {
    return this.usersService.getUserPhoneNumber(req.user.id);
  }

  /**
   * Provision a new phone number for current user
   * POST /v1/users/me/phone-number/provision
   */
  @Post('me/phone-number/provision')
  async provisionPhoneNumber(@Request() req: any, @Query('areaCode') areaCode?: string) {
    return this.usersService.provisionPhoneNumber(req.user.id, areaCode);
  }

  /**
   * Search available phone numbers
   * GET /v1/users/phone-numbers/search?country=US&areaCode=813
   */
  @Get('phone-numbers/search')
  async searchPhoneNumbers(
    @Query('country') country?: string,
    @Query('areaCode') areaCode?: string,
  ): Promise<SigcoreSearchResult[]> {
    return this.usersService.searchAvailableNumbers(country || 'US', areaCode);
  }

  /**
   * Get current user's assigned pool phone
   * GET /v1/users/me/pool-phone
   */
  @Get('me/pool-phone')
  async getMyPoolPhone(@Request() req: any) {
    return this.usersService.getUserPoolPhone(req.user.id);
  }
}
