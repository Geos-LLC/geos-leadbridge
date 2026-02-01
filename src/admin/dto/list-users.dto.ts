import { IsOptional, IsString, IsEnum, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { SubscriptionTier } from '../../../generated/prisma';

export class ListUsersDto {
  @IsOptional()
  @IsString()
  search?: string; // Search by email or name

  @IsOptional()
  @IsEnum(SubscriptionTier)
  tier?: SubscriptionTier; // Filter by subscription tier

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
