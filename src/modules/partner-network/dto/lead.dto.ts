import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import {
  PartnerLeadContactPref,
  PartnerLeadIntent,
  PartnerLeadStatus,
} from '../../../../generated/prisma';

// Body of POST /api/partner-network/public/r/:code/submit. The referral code
// resolves source/destination on the server — clients never send IDs.
export class SubmitPartnerLeadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  customerName!: string;

  @IsString()
  @MinLength(7)
  @MaxLength(40)
  customerPhone!: string;

  @IsEnum(PartnerLeadIntent)
  intentTiming!: PartnerLeadIntent;

  @IsOptional()
  @IsEnum(PartnerLeadContactPref)
  preferredContact?: PartnerLeadContactPref;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  utmSource?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  utmMedium?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  utmCampaign?: string;
}

export class UpdatePartnerLeadDto {
  @IsOptional()
  @IsEnum(PartnerLeadStatus)
  status?: PartnerLeadStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  assignedTo?: string;
}
