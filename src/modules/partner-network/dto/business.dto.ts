import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreatePartnerBusinessDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  website?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  serviceArea?: string;
}

export class UpdatePartnerBusinessDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  website?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  serviceArea?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
