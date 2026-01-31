import { IsOptional, IsString, IsDateString } from 'class-validator';

export class AnalyticsQueryDto {
  @IsOptional()
  @IsString()
  businessId?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;
}
