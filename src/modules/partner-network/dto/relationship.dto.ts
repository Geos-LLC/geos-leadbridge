import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

// Body for POST /partner-network/relationships/ai-suggest. The endpoint
// returns AI-generated `{ name, offerText }` grounded in the two businesses'
// names + categories + cached website metadata (when present). `hint` lets
// the admin steer the output, e.g. "focus on first-time discount".
export class SuggestRelationshipCopyDto {
  @IsUUID()
  sourceBusinessId!: string;

  @IsUUID()
  destinationBusinessId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  hint?: string;
}

export class CreatePartnerRelationshipDto {
  @IsUUID()
  sourceBusinessId!: string;

  @IsUUID()
  destinationBusinessId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  defaultOfferText?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsBoolean()
  widgetEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  widgetType?: string;

  // Future popup-widget settings. Persisted now so the relationship can be
  // configured before the runtime exists; widget loader will read these.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120000)
  popupDelayMs?: number;

  @IsOptional()
  @IsBoolean()
  autoOpenFromReferral?: boolean;
}

export class UpdatePartnerRelationshipDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  defaultOfferText?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsBoolean()
  widgetEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  widgetType?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120000)
  popupDelayMs?: number;

  @IsOptional()
  @IsBoolean()
  autoOpenFromReferral?: boolean;
}
