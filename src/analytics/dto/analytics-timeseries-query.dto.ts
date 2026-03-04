import { IsOptional, IsIn } from 'class-validator';
import { AnalyticsQueryDto } from './analytics-query.dto';

export class TimeSeriesQueryDto extends AnalyticsQueryDto {
  @IsOptional()
  @IsIn(['day', 'week', 'month', 'year'])
  period?: 'day' | 'week' | 'month' | 'year';
}
