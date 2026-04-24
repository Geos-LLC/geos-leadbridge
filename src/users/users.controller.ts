import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Request, UseGuards } from '@nestjs/common';
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
   * Get all phone options for the current user — dedicated numbers only
   * GET /v1/users/me/phone-options
   */
  @Get('me/phone-options')
  async getPhoneOptions(@Request() req: any) {
    return this.usersService.getAllPhoneOptions(req.user.id);
  }

  /**
   * Update current user's profile
   * PATCH /v1/users/me
   */
  @Patch('me')
  async updateProfile(@Request() req: any, @Body() body: { name?: string; businessPhone?: string }) {
    return this.usersService.updateProfile(req.user.id, body);
  }

  /**
   * Get the user's global AI prompt
   * GET /v1/users/me/ai-prompt
   */
  @Get('me/ai-prompt')
  async getGlobalAiPrompt(@Request() req: any) {
    return this.usersService.getGlobalAiPrompt(req.user.id);
  }

  /**
   * Update the user's global AI prompt
   * PATCH /v1/users/me/ai-prompt
   */
  @Patch('me/ai-prompt')
  async updateGlobalAiPrompt(@Request() req: any, @Body() body: { prompt: string }) {
    return this.usersService.updateGlobalAiPrompt(req.user.id, body.prompt);
  }

  /**
   * Get pricing config for an account
   * GET /v1/users/me/pricing/:accountId
   */
  @Get('me/pricing/:accountId')
  async getPricing(@Request() req: any, @Param('accountId') accountId: string) {
    return this.usersService.getServicePricing(req.user.id, accountId);
  }

  /**
   * Save pricing config for an account
   * PATCH /v1/users/me/pricing/:accountId
   */
  @Patch('me/pricing/:accountId')
  async updatePricing(@Request() req: any, @Param('accountId') accountId: string, @Body() body: { pricing: any }) {
    return this.usersService.updateServicePricing(req.user.id, accountId, body.pricing);
  }

  /**
   * Copy an account's pricing to every other account owned by the same user.
   * POST /v1/users/me/pricing/:accountId/copy-to-all
   */
  @Post('me/pricing/:accountId/copy-to-all')
  async copyPricingToAll(@Request() req: any, @Param('accountId') accountId: string) {
    return this.usersService.copyServicePricingToAll(req.user.id, accountId);
  }

  /**
   * Delete the current user's own account
   * DELETE /v1/users/me
   */
  @Delete('me')
  async deleteOwnAccount(@Request() req: any) {
    const result = await this.usersService.deleteOwnAccount(req.user.id);
    return { success: true, data: result };
  }
}
