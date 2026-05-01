import {
  IsString,
  IsOptional,
  IsNumber,
  IsDateString,
  ValidateNested,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';

class PageDto {
  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsString()
  title?: string;
}

class ScopeDto {
  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  location?: string;

  // Calendar period the snapshot applies to, formatted as 'YYYY-MM'.
  // Used for Yelp monthly budgets so each month has its own history.
  @IsOptional()
  @IsString()
  period?: string;
}

class BudgetDto {
  @IsNumber()
  weekly: number;

  @IsOptional()
  @IsString()
  currency?: string;
}

export class BudgetSnapshotDto {
  @IsOptional()
  @IsString()
  savedAccountId?: string;

  @IsOptional()
  @IsString()
  provider?: string;

  @IsOptional()
  @IsString()
  snapshotType?: string;

  @IsDateString()
  capturedAt: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PageDto)
  page?: PageDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ScopeDto)
  scope?: ScopeDto;

  @ValidateNested()
  @Type(() => BudgetDto)
  budget: BudgetDto;

  @IsOptional()
  @IsObject()
  raw?: Record<string, any>;
}
