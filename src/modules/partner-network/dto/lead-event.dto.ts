import { IsEnum } from 'class-validator';
import { PartnerLeadEventType } from '../../../../generated/prisma';

// Body of POST /api/partner-network/public/r/:code/events. Public endpoint —
// no auth, no client-supplied IDs. The :code resolves the referral code; the
// only thing the client can choose is the event type. form_submitted is
// reserved for the /submit endpoint to keep funnel data trustworthy.
export class LogPartnerLeadEventDto {
  @IsEnum(PartnerLeadEventType)
  eventType!: PartnerLeadEventType;
}
