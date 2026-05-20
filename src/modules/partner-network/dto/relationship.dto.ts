import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

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
