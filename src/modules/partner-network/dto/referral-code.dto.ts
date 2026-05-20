import { IsBoolean, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

export class CreatePartnerReferralCodeDto {
  // Code is alphanumeric + hyphens; URL-safe so it can be used directly in
  // /r/:code without further encoding. Server normalizes to uppercase.
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  @Matches(/^[A-Za-z0-9-]+$/, {
    message: 'code must contain only letters, digits, and hyphens',
  })
  code!: string;

  @IsUUID()
  sourceBusinessId!: string;

  @IsUUID()
  destinationBusinessId!: string;

  @IsOptional()
  @IsUUID()
  partnerRelationshipId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  employeeName?: string;
}

export class UpdatePartnerReferralCodeDto {
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  employeeName?: string;
}
