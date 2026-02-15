import { IsOptional, IsString, IsIn, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListUsersDto {
  @IsOptional()
  @IsString()
  search?: string; // Search by email or name

  @IsOptional()
  @IsIn(['STARTER', 'PRO', 'ENTERPRISE', 'FREE'])
  tier?: string; // Filter by subscription tier (FREE = no tier, trial users)

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 50;
}
