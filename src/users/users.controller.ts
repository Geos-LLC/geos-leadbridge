import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Request, UseGuards, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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
  async updateProfile(
    @Request() req: any,
    @Body() body: {
      name?: string;
      businessPhone?: string;
      website?: string | null;
      websiteMetadata?: { title?: string; description?: string; phone?: string } | null;
    },
  ) {
    return this.usersService.updateProfile(req.user.id, body);
  }

  /**
   * Verify a website URL: normalize, SSRF-guard, fetch with timeout,
   * extract basic metadata. Called by the onboarding wizard's
   * Business step before persisting the URL.
   * POST /v1/users/me/website/verify
   */
  @Post('me/website/verify')
  async verifyWebsite(@Request() req: any, @Body() body: { url?: string }) {
    return this.usersService.verifyWebsite(body?.url ?? '');
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
   * Get the user's business hours (master window in Settings → General)
   * GET /v1/users/me/business-hours
   */
  @Get('me/business-hours')
  async getBusinessHours(@Request() req: any) {
    return this.usersService.getBusinessHours(req.user.id);
  }

  /**
   * Update business hours
   * PATCH /v1/users/me/business-hours
   */
  @Patch('me/business-hours')
  async updateBusinessHours(
    @Request() req: any,
    @Body() body: { timezone?: string; schedule?: Record<string, { start: string; end: string } | null> },
  ) {
    return this.usersService.updateBusinessHours(req.user.id, body);
  }

  /**
   * Get the user's quiet hours (daily "don't text leads at night" window)
   * GET /v1/users/me/quiet-hours
   */
  @Get('me/quiet-hours')
  async getQuietHours(@Request() req: any) {
    return this.usersService.getQuietHours(req.user.id);
  }

  /**
   * Update quiet hours
   * PATCH /v1/users/me/quiet-hours
   */
  @Patch('me/quiet-hours')
  async updateQuietHours(
    @Request() req: any,
    @Body() body: { enabled?: boolean; start?: string; end?: string; timezone?: string },
  ) {
    return this.usersService.updateQuietHours(req.user.id, body);
  }

  /**
   * Get per-account hours toggles + optional override window
   * GET /v1/users/me/account-hours/:accountId
   */
  @Get('me/account-hours/:accountId')
  async getAccountHours(@Request() req: any, @Param('accountId') accountId: string) {
    return this.usersService.getAccountHoursSettings(req.user.id, accountId);
  }

  /**
   * Update per-account hours toggles + optional override window
   * PATCH /v1/users/me/account-hours/:accountId
   */
  @Patch('me/account-hours/:accountId')
  async updateAccountHours(
    @Request() req: any,
    @Param('accountId') accountId: string,
    @Body() body: {
      override?: { start?: string; end?: string; timezone?: string; days?: string[] } | null;
      callDuringBusinessHours?: boolean;
      firstMsgDuringBusinessHours?: boolean;
      followUpsApplyQuietHours?: boolean;
      aiConversationMode?: 'always' | 'when_dispatcher_unavailable';
    },
  ) {
    return this.usersService.updateAccountHoursSettings(req.user.id, accountId, body);
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
   * Get the per-account FAQ
   * GET /v1/users/me/faq/:accountId
   */
  @Get('me/faq/:accountId')
  async getFaq(@Request() req: any, @Param('accountId') accountId: string) {
    return this.usersService.getAccountFaq(req.user.id, accountId);
  }

  /**
   * Save the per-account FAQ
   * PATCH /v1/users/me/faq/:accountId
   */
  @Patch('me/faq/:accountId')
  async updateFaq(@Request() req: any, @Param('accountId') accountId: string, @Body() body: { faq: any }) {
    return this.usersService.updateAccountFaq(req.user.id, accountId, body.faq);
  }

  /**
   * Copy an account's FAQ to every other account owned by the same user.
   * POST /v1/users/me/faq/:accountId/copy-to-all
   */
  @Post('me/faq/:accountId/copy-to-all')
  async copyFaqToAll(@Request() req: any, @Param('accountId') accountId: string) {
    return this.usersService.copyAccountFaqToAll(req.user.id, accountId);
  }

  /**
   * Parse an uploaded checklist file (PDF, DOCX, TXT, MD) and return its
   * extracted text so the frontend can drop it into a scope textarea.
   * Storage is intentionally NOT persisted — the user reviews the parsed
   * text and saves it as part of the FAQ JSON.
   * POST /v1/users/me/faq/parse-checklist
   */
  @Post('me/faq/parse-checklist')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async parseChecklist(@UploadedFile() file?: any) {
    if (!file?.buffer) throw new BadRequestException('No file uploaded');
    const name = (file.originalname || '').toLowerCase();
    const mime = file.mimetype || '';
    const buf: Buffer = file.buffer;

    let text = '';
    try {
      if (name.endsWith('.pdf') || mime === 'application/pdf') {
        const pdfParse = require('pdf-parse');
        const out = await pdfParse(buf);
        text = (out?.text || '').trim();
      } else if (name.endsWith('.docx') || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        const mammoth = require('mammoth');
        const out = await mammoth.extractRawText({ buffer: buf });
        text = (out?.value || '').trim();
      } else if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.csv') || mime.startsWith('text/')) {
        text = buf.toString('utf8').trim();
      } else {
        throw new BadRequestException('Unsupported file type. Use PDF, DOCX, TXT, or MD.');
      }
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(`Could not parse file: ${err.message || 'unknown error'}`);
    }

    if (!text) throw new BadRequestException('File parsed, but no text was found.');

    // Cap at ~20KB of plaintext so a giant manual doesn't blow up the prompt
    const MAX = 20_000;
    const truncated = text.length > MAX;
    if (truncated) text = text.slice(0, MAX);

    return { success: true, text, truncated, originalLength: text.length };
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
