import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

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
}
