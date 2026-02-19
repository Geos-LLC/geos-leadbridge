import {
  IsString,
  IsOptional,
  IsDateString,
  IsArray,
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

export class CollectLeadsDto {
  @IsOptional()
  @IsString()
  savedAccountId?: string;

  @IsOptional()
  @IsString()
  provider?: string;

  @IsDateString()
  capturedAt: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PageDto)
  page?: PageDto;

  @IsArray()
  @IsString({ each: true })
  leadIds: string[];

  @IsOptional()
  @IsObject()
  leadStatuses?: Record<string, string>;

  @IsOptional()
  @IsObject()
  leadNames?: Record<string, string>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
