import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

// Verify-website metadata captured by the frontend when the admin clicks
// "Verify" on the business form. Same shape as User.websiteMetadataJson.
export interface PartnerBusinessWebsiteMetadata {
  title?: string;
  description?: string;
  phone?: string;
}

// Phone format is loose at the DTO layer: any string is accepted; the service
// layer normalizes via normalizePhoneE164 and throws BadRequestException if
// the input has fewer than 10 digits. We can't easily express "≥10 digits"
// as a class-validator decorator without a custom validator class.

// Website: class-validator's @IsUrl with require_protocol: false accepts both
// "myco.com" and "https://myco.com". Service layer normalizes via
// normalizeWebsiteUrl, which adds the protocol + SSRF-guards before save.
const URL_OPTS = { require_protocol: false, require_tld: true, require_valid_protocol: true };

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
  @IsUrl(URL_OPTS, { message: 'website must look like example.com or https://example.com' })
  website?: string;

  // Populated by the frontend after a successful Verify call. Backend trusts
  // shape but coerces to PartnerBusinessWebsiteMetadata before save — extra
  // keys are dropped to keep stored JSON predictable.
  @IsOptional()
  @IsObject()
  websiteMetadata?: PartnerBusinessWebsiteMetadata;

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
  @IsUrl(URL_OPTS, { message: 'website must look like example.com or https://example.com' })
  website?: string;

  @IsOptional()
  @IsObject()
  websiteMetadata?: PartnerBusinessWebsiteMetadata;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  serviceArea?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
