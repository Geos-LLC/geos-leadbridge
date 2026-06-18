import { Body, Controller, Get, Post, Query, UseGuards, Logger, BadRequestException } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AiSettingsAssistantService } from './assistant.service';
import { ApplyRequest, InterpretRequest } from './assistant.types';

@Controller('v1/ai-settings-assistant')
@UseGuards(JwtAuthGuard)
export class AiSettingsAssistantController {
  private readonly logger = new Logger(AiSettingsAssistantController.name);

  constructor(private readonly service: AiSettingsAssistantService) {}

  /**
   * Interpret a natural-language settings request. Returns one of four
   * status variants (apply_ready / needs_clarification / conflict /
   * unsupported). Only `apply_ready` carries a signed `proposal`; the
   * frontend echoes that exact object back to /apply.
   */
  @Post('interpret')
  async interpret(
    @CurrentUser() user: any,
    @Body() body: InterpretRequest,
  ) {
    this.logger.log(
      `[interpret] user=${user?.id} surface=${body?.context?.surface ?? '-'} acct=${body?.context?.savedAccountId ?? '-'} msgLen=${(body?.message || '').length}`,
    );
    return this.service.interpret(user.id, body);
  }

  /**
   * Apply a signed proposal. Verifies signature + expiry + user match, runs
   * a second safety check, writes through the writer, and appends an audit
   * row. Frontend cannot synthesize a proposal — the only valid input here
   * is a proposal returned from /interpret.
   */
  @Post('apply')
  async apply(
    @CurrentUser() user: any,
    @Body() body: ApplyRequest,
  ) {
    return this.service.apply(user.id, body);
  }

  /**
   * List the chat-added instructions for an area. Used by the AI Playbook
   * Custom Instructions sub-section to render the list of deletable
   * entries. For global, `savedAccountId` is omitted; for per-section
   * playbook areas (business_information / pricing_guidance /
   * brand_voice), `savedAccountId` is required and scoped to the caller.
   */
  @Get('chat-instructions')
  async listChatInstructions(
    @CurrentUser() user: any,
    @Query('area') area: string,
    @Query('savedAccountId') savedAccountId?: string,
  ) {
    this.logger.log(`[list] user=${user?.id} area=${area} acct=${savedAccountId ?? '-'}`);
    if (!area) throw new BadRequestException('area is required');
    return this.service.listChatInstructions(user.id, area, savedAccountId);
  }

  /**
   * Delete a single chat-added instruction by id. Same area/scope rules
   * as the list endpoint. Returns the remaining list so the UI can
   * reconcile without a second round-trip.
   */
  @Post('chat-instructions/delete')
  async deleteChatInstruction(
    @CurrentUser() user: any,
    @Body() body: { area?: string; entryId?: string; savedAccountId?: string },
  ) {
    this.logger.log(
      `[delete] user=${user?.id} area=${body?.area ?? '-'} entryId=${body?.entryId ?? '-'} acct=${body?.savedAccountId ?? '-'}`,
    );
    if (!body?.area || !body?.entryId) {
      throw new BadRequestException('area and entryId are required');
    }
    return this.service.deleteChatInstruction(user.id, body.area, body.entryId, body.savedAccountId);
  }
}
