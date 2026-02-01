import { IsOptional, IsEnum, IsBoolean } from 'class-validator';
import { SubscriptionTier, SubscriptionStatus } from '../../../generated/prisma';

export class UpdateSubscriptionDto {
  @IsOptional()
  @IsEnum(SubscriptionTier)
  tier?: SubscriptionTier;

  @IsOptional()
  @IsEnum(SubscriptionStatus)
  status?: SubscriptionStatus;

  @IsOptional()
  @IsBoolean()
  hasOwnNumber?: boolean;
}
