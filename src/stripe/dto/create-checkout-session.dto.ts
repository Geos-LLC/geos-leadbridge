import { IsString, IsArray, IsOptional, IsEnum } from 'class-validator';
import { SubscriptionTier } from '../../../generated/prisma';

export class CreateCheckoutSessionDto {
  @IsEnum(SubscriptionTier)
  tier: SubscriptionTier;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  addOns?: string[]; // e.g., ['ownNumber']
}
