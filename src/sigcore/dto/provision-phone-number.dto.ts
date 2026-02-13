import { IsString, IsOptional } from 'class-validator';

export class ProvisionPhoneNumberDto {
  @IsString()
  @IsOptional()
  country?: string = 'US';

  @IsString()
  @IsOptional()
  areaCode?: string;

  @IsString()
  @IsOptional()
  phoneNumber?: string; // If user selects a specific number
}
