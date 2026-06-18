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
      // additionalAssociatePhones moved to PATCH /v1/thumbtack/saved-accounts/:id
      // (per-business, stored on SavedAccount.followUpSettingsJson). The legacy
      // User.additionalAssociatePhonesJson column stays in schema for backfill /
      // archival reads but accepts no new writes from this endpoint.
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
   * Apply the structured Playbook seed (from `User.websiteMetadataJson.
   * playbookSeed`) to every connected SavedAccount's `aiPlaybookV2`.
   *
   * mode: 'fill_empty' (default) only sets sections whose customInstructions
   *       is empty / blank — protects user-typed text.
   *       'replace' overwrites every supported section unconditionally.
   *
   * The call is idempotent in fill_empty mode (re-applying the same seed
   * to an already-filled section is a no-op).
   *
   * POST /v1/users/me/website/apply-playbook
   */
  @Post('me/website/apply-playbook')
  async applyPlaybookSeed(
    @Request() req: any,
    @Body() body: { mode?: 'fill_empty' | 'replace' },
  ) {
    return this.usersService.applyPlaybookSeedToAccounts(
      req.user.id,
      body?.mode === 'replace' ? 'replace' : 'fill_empty',
    );
  }

  /**
   * Apply the website seed's businessInformation fields into each
   * connected SavedAccount's `faqJson`. Always fill-empty — never
   * overwrites a user-typed FAQ answer. Targets the 4 FAQ fields
   * derivable from a marketing site: insuredAndBonded, bringsSupplies,
   * petPolicy, paymentMethods.
   *
   * POST /v1/users/me/website/apply-faq
   */
  @Post('me/website/apply-faq')
  async applyFaqFromSeed(@Request() req: any) {
    return this.usersService.applyFaqFromWebsiteSeed(req.user.id);
  }

  /**
   * Pull business-info from a connected SavedAccount and merge into the
   * canonical seed. Used by the "Pull from Thumbtack / Pull from Yelp"
   * buttons on Settings → General and called automatically when a new
   * platform is connected.
   *
   * POST /v1/users/me/business-info/pull-from/:platform/:savedAccountId
   *   platform = 'thumbtack' | 'yelp'
   */
  @Post('me/business-info/pull-from/:platform/:savedAccountId')
  async pullBusinessInfoFromAccount(
    @Request() req: any,
    @Param('platform') platform: string,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    const normalized = platform === 'yelp' ? 'yelp' : platform === 'thumbtack' ? 'thumbtack' : null;
    if (!normalized) throw new BadRequestException(`Unsupported platform: ${platform}`);
    return this.usersService.seedBusinessInfoFromAccount(req.user.id, savedAccountId, normalized);
  }

  /**
   * Save the tenant's public Thumbtack profile URL onto a SavedAccount.
   * Used to enable the website-scrape path for Thumbtack pulls — the
   * Partner API alone returns only minimal data, but the public profile
   * page has the full picture (services, address, insurance, pricing).
   *
   * PATCH /v1/users/me/saved-accounts/:savedAccountId/thumbtack-profile-url
   *   body: { url: string | null }
   *     - url=null clears the saved value
   *     - url must be a thumbtack.com URL; rejected otherwise with a
   *       structured warning so the frontend can surface a clean error
   */
  @Patch('me/saved-accounts/:savedAccountId/thumbtack-profile-url')
  async saveThumbtackProfileUrl(
    @Request() req: any,
    @Param('savedAccountId') savedAccountId: string,
    @Body() body: { url?: string | null },
  ) {
    return this.usersService.saveThumbtackProfileUrl(
      req.user.id,
      savedAccountId,
      body?.url ?? null,
    );
  }

  /**
   * Read the saved Thumbtack profile URL for a SavedAccount. Used by
   * Settings → General to hydrate the input field on page mount.
   *
   * GET /v1/users/me/saved-accounts/:savedAccountId/thumbtack-profile-url
   *   response: { url: string | null }
   */
  @Get('me/saved-accounts/:savedAccountId/thumbtack-profile-url')
  async getThumbtackProfileUrl(
    @Request() req: any,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    return this.usersService.getThumbtackProfileUrl(req.user.id, savedAccountId);
  }

  /**
   * Unified Business profile URL handler — wizard + Settings → General
   * both call this. Accepts a Thumbtack profile URL, a Yelp business
   * URL, or any other website. The service detects the platform from
   * hostname:
   *   - thumbtack.com → save as `publicProfileUrl` on every connected TT
   *     account, then run the TT seed pipeline.
   *   - yelp.com → same fan-out for Yelp accounts.
   *   - any other host → save as User.website + verify + apply Playbook
   *     and FAQ seeds.
   *
   * POST /v1/users/me/business-url/apply
   *   body: { url: string }
   *   returns: { success, platform, savedUrl, accountsAffected, fieldsApplied,
   *             conflictsRaised, websiteMetadata?, warning? }
   */
  @Post('me/business-url/apply')
  async applyBusinessProfileUrl(@Request() req: any, @Body() body: { url?: string }) {
    return this.usersService.applyBusinessProfileUrl(req.user.id, body?.url ?? '');
  }

  /**
   * Manual-paste fallback for the Business URL apply flow. When the URL
   * scrape returns nothing (Cloudflare-blocked Yelp, BookingKoala SPA,
   * meta-less generic site), the user pastes the business info as freeform
   * text and we route it through the same GPT-4o-mini → playbookSeed →
   * apply-to-accounts pipeline as the URL path.
   *
   * POST /v1/users/me/business-info/seed-from-text
   *   body: { text: string }
   *   returns: { success, fieldsApplied, conflictsRaised, warning? }
   */
  @Post('me/business-info/seed-from-text')
  async seedBusinessInfoFromText(@Request() req: any, @Body() body: { text?: string }) {
    return this.usersService.seedBusinessInfoFromText(req.user.id, body?.text ?? '');
  }

  /**
   * Resolve the current Business profile URL for the unified field —
   * used by both the wizard step and Settings → General to hydrate the
   * input on mount. Resolution order: TT publicProfileUrl > Yelp
   * publicProfileUrl > User.website.
   *
   * GET /v1/users/me/business-url
   *   returns: { url: string | null, platform: 'thumbtack' | 'yelp' | 'website' | null }
   */
  @Get('me/business-url')
  async getBusinessProfileUrl(@Request() req: any) {
    return this.usersService.getBusinessProfileUrl(req.user.id);
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
   * Parse an uploaded checklist file and return its extracted text so the
   * frontend can drop it into a scope textarea. Storage is intentionally
   * NOT persisted — the user reviews the parsed text and saves it as part
   * of the FAQ JSON.
   *
   * Supported formats:
   *   - PDF                       (pdf-parse)
   *   - Word DOCX                 (mammoth)
   *   - Excel XLSX/XLS            (xlsx / sheetjs)
   *   - Plain text / Markdown     (utf-8 read)
   *   - CSV / TSV                 (utf-8 read)
   *   - Images: JPG/PNG/WEBP/GIF  (OpenAI vision OCR)
   *
   * Legacy .doc is rejected (mammoth only handles .docx) — the user is
   * asked to re-save as .docx or PDF.
   *
   * POST /v1/users/me/faq/parse-checklist
   */
  @Post('me/faq/parse-checklist')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async parseChecklist(@UploadedFile() file?: any) {
    if (!file?.buffer) throw new BadRequestException('No file uploaded');
    const name = (file.originalname || '').toLowerCase();
    const mime = file.mimetype || '';
    const buf: Buffer = file.buffer;

    const isImage =
      mime.startsWith('image/') ||
      /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(name);

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
      } else if (name.endsWith('.doc') || mime === 'application/msword') {
        throw new BadRequestException('Legacy .doc files are not supported. Open the file in Word and "Save As" .docx, or export as PDF.');
      } else if (
        name.endsWith('.xlsx') ||
        name.endsWith('.xls') ||
        name.endsWith('.xlsm') ||
        name.endsWith('.ods') ||
        mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        mime === 'application/vnd.ms-excel' ||
        mime === 'application/vnd.oasis.opendocument.spreadsheet'
      ) {
        const XLSX = require('xlsx');
        const wb = XLSX.read(buf, { type: 'buffer' });
        const sheets: string[] = [];
        for (const sheetName of wb.SheetNames) {
          const sheet = wb.Sheets[sheetName];
          // CSV-style output keeps rows on their own lines and skips empty cells,
          // which is what we want for a checklist (each row = one bullet).
          const csv = (XLSX.utils.sheet_to_csv(sheet, { blankrows: false }) || '').trim();
          if (csv) {
            sheets.push(wb.SheetNames.length > 1 ? `# ${sheetName}\n${csv}` : csv);
          }
        }
        text = sheets.join('\n\n').trim();
      } else if (isImage) {
        text = (await this.ocrImageWithOpenAI(buf, mime || 'image/jpeg')).trim();
      } else if (
        name.endsWith('.txt') ||
        name.endsWith('.md') ||
        name.endsWith('.markdown') ||
        name.endsWith('.csv') ||
        name.endsWith('.tsv') ||
        name.endsWith('.rtf') ||
        mime.startsWith('text/')
      ) {
        text = buf.toString('utf8').trim();
        // Strip RTF control words so the user gets readable text, not raw markup.
        if (name.endsWith('.rtf')) {
          text = text
            .replace(/\\par[d]?/g, '\n')
            .replace(/\{\\[^}]+\}/g, '')
            .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
            .replace(/[{}]/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        }
      } else {
        throw new BadRequestException('Unsupported file type. Use PDF, DOCX, XLSX, CSV, TXT, MD, or an image (JPG/PNG).');
      }
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(`Could not parse file: ${err.message || 'unknown error'}`);
    }

    if (!text) throw new BadRequestException('File parsed, but no text was found.');

    // Cap at ~20KB of plaintext so a giant manual doesn't blow up the prompt
    const MAX = 20_000;
    const originalLength = text.length;
    const truncated = text.length > MAX;
    if (truncated) text = text.slice(0, MAX);

    return { success: true, text, truncated, originalLength };
  }

  /**
   * Extract checklist text from an image via OpenAI vision. Pulled out so the
   * main handler stays readable.
   */
  private async ocrImageWithOpenAI(buf: Buffer, mime: string): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new BadRequestException('Image checklists need OPENAI_API_KEY configured on the server.');
    }
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey });
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    const resp = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 2000,
      messages: [
        {
          role: 'system',
          content:
            'You extract cleaning checklist items from an image (photo or screenshot). Return only the list items as plain text, one per line, no commentary, no markdown bullets. Preserve room or section headings on their own lines if present.',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Extract the checklist text from this image.' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ] as any,
        },
      ],
    });
    return resp.choices?.[0]?.message?.content || '';
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
