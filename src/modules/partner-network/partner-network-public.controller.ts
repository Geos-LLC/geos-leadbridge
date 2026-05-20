/**
 * Partner Network Public Controller
 *
 * Unauthenticated endpoints used by the customer-facing /r/:code page:
 *  - GET  /api/partner-network/public/r/:code         → display info
 *  - POST /api/partner-network/public/r/:code/events  → log page_view / form_started
 *  - POST /api/partner-network/public/r/:code/submit  → submit lead
 *
 * Source/destination/workspaceId are resolved server-side from :code. Any
 * client-supplied IDs are ignored. The events endpoint is intentionally
 * narrow — clients cannot post `form_submitted` here; that's reserved for
 * /submit so the funnel can't be gamed.
 */

import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { PartnerNetworkService } from './partner-network.service';
import { SubmitPartnerLeadDto } from './dto/lead.dto';
import { LogPartnerLeadEventDto } from './dto/lead-event.dto';

@Controller('partner-network/public')
@Public()
export class PartnerNetworkPublicController {
  constructor(private readonly service: PartnerNetworkService) {}

  @Get('r/:code')
  async getReferralView(@Param('code') code: string) {
    return { success: true, referral: await this.service.getPublicReferralView(code) };
  }

  @Post('r/:code/events')
  @HttpCode(200)
  async logEvent(@Param('code') code: string, @Body() body: LogPartnerLeadEventDto) {
    return this.service.recordPublicEvent(code, body.eventType);
  }

  @Post('r/:code/submit')
  @HttpCode(200)
  async submitLead(@Param('code') code: string, @Body() body: SubmitPartnerLeadDto) {
    const lead = await this.service.submitPublicLead(code, body);
    // Don't leak internal IDs/status to the public form; just confirm receipt.
    return { success: true, leadId: lead.id, possibleDuplicate: lead.possibleDuplicate };
  }
}
