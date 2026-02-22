/**
 * Call Connect Controller
 * REST endpoints for Instant Call Connect settings and lead sessions
 */

import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Request,
  HttpCode,
  HttpStatus,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// Ensure upload directory exists on module load
const VOICEMAIL_DIR = path.join(process.cwd(), 'uploads', 'voicemail');
if (!fs.existsSync(VOICEMAIL_DIR)) {
  fs.mkdirSync(VOICEMAIL_DIR, { recursive: true });
}
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CallConnectService, SaveCallConnectSettingsDto } from './call-connect.service';
import { PrismaService } from '../common/utils/prisma.service';

const ALLOWED_AUDIO_MIMES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave', 'audio/x-wav'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

@UseGuards(JwtAuthGuard)
@Controller('v1/call-connect')
export class CallConnectController {
  constructor(
    private callConnectService: CallConnectService,
    private prisma: PrismaService,
  ) {}

  /**
   * GET /api/v1/call-connect/settings?accountId=<savedAccountId>
   * Returns current call-connect settings for a saved account.
   */
  @Get('settings')
  async getSettings(@Query('accountId') accountId: string, @Request() req: any) {
    if (!accountId) {
      return { settings: null };
    }

    // Verify the saved account belongs to the requesting user
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: accountId, userId: req.user.id },
    });
    if (!account) throw new ForbiddenException('Account not found');

    const settings = await this.callConnectService.getSettings(accountId);
    return { settings: settings || null };
  }

  /**
   * PUT /api/v1/call-connect/settings
   * Save / update call-connect settings for an account.
   */
  @Put('settings')
  async saveSettings(
    @Body()
    body: SaveCallConnectSettingsDto & { savedAccountId: string },
    @Request() req: any,
  ) {
    const { savedAccountId, ...dto } = body;

    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId: req.user.id },
    });
    if (!account) throw new ForbiddenException('Account not found');

    if (!this.callConnectService.canUseCallConnect(req.user.id)) {
      throw new ForbiddenException('Instant Call Connect is not available on your current plan');
    }

    const settings = await this.callConnectService.saveSettings(req.user.id, savedAccountId, dto);
    return { settings };
  }

  /**
   * GET /api/v1/call-connect/lead/:leadId
   * Returns all call-connect sessions for a specific lead.
   */
  @Get('lead/:leadId')
  async getLeadSessions(@Param('leadId') leadId: string, @Request() req: any) {
    // Verify the lead belongs to the user
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, userId: req.user.id },
    });
    if (!lead) throw new ForbiddenException('Lead not found');

    const sessions = await this.callConnectService.getSessionsForLead(leadId);
    return { sessions };
  }

  /**
   * POST /api/v1/call-connect/test
   * Fire a test call to verify call-connect works end-to-end.
   */
  @Post('test')
  @HttpCode(HttpStatus.OK)
  async testCall(
    @Body() body: { savedAccountId: string; testPhone: string },
    @Request() req: any,
  ) {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: body.savedAccountId, userId: req.user.id },
    });
    if (!account) throw new ForbiddenException('Account not found');

    const result = await this.callConnectService.triggerTestCall(body.savedAccountId, body.testPhone);
    return { triggered: true, sessionId: result.sessionId };
  }

  /**
   * POST /api/v1/call-connect/cancel
   * Cancel an active call-connect session.
   */
  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  async cancelSession(
    @Body() body: { sessionId: string; savedAccountId: string },
    @Request() req: any,
  ) {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: body.savedAccountId, userId: req.user.id },
    });
    if (!account) throw new ForbiddenException('Account not found');

    await this.callConnectService.cancelSession(body.sessionId, body.savedAccountId);
    return { cancelled: true };
  }

  /**
   * POST /api/v1/call-connect/upload-voicemail
   * Upload an MP3/WAV file for voicemail recording.
   */
  @Post('upload-voicemail')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: VOICEMAIL_DIR,
        filename: (_req, file, cb) => {
          const ext = path.extname(file.originalname) || '.mp3';
          cb(null, `${crypto.randomUUID()}${ext}`);
        },
      }),
      limits: { fileSize: MAX_FILE_SIZE },
      fileFilter: (_req, file, cb) => {
        if (ALLOWED_AUDIO_MIMES.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new BadRequestException('Only MP3 and WAV files are allowed'), false);
        }
      },
    }),
  )
  async uploadVoicemail(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { savedAccountId: string },
    @Request() req: any,
  ) {
    if (!file) throw new BadRequestException('No audio file provided');

    const account = await this.prisma.savedAccount.findFirst({
      where: { id: body.savedAccountId, userId: req.user.id },
    });
    if (!account) throw new ForbiddenException('Account not found');

    // Build public URL for the uploaded file
    const recordingUrl = `/uploads/voicemail/${file.filename}`;

    // Persist URL in settings
    await this.callConnectService.saveSettings(req.user.id, body.savedAccountId, {
      leadVoicemailRecordingUrl: recordingUrl,
    });

    return { recordingUrl };
  }
}
