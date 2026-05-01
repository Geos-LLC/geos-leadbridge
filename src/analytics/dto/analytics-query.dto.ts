import { IsOptional, IsString, IsDateString, IsIn } from 'class-validator';

export class AnalyticsQueryDto {
  @IsOptional()
  @IsString()
  businessId?: string;

  @IsOptional()
  @IsIn(['thumbtack', 'yelp'])
  platform?: 'thumbtack' | 'yelp';

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;
}
