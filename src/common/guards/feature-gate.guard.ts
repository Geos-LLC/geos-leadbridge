import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubscriptionTier, SubscriptionStatus } from '../../../generated/prisma';

export enum Feature {
  CUSTOM_REPLIES = 'CUSTOM_REPLIES',   // Starter+
  PHONE_CALLS = 'PHONE_CALLS',         // Pro+
  AI_FOLLOWUPS = 'AI_FOLLOWUPS',       // Enterprise only
  OWN_NUMBER = 'OWN_NUMBER',           // Add-on
}

@Injectable()
export class FeatureGateGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredFeature = this.reflector.get<Feature>('feature', context.getHandler());

    if (!requiredFeature) {
      return true; // No feature requirement
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.subscriptionTier) {
      throw new ForbiddenException('Active subscription required');
    }

    const hasFeature = this.checkFeatureAccess(user, requiredFeature);

    if (!hasFeature) {
      throw new ForbiddenException(
        `Feature requires ${this.getRequiredTier(requiredFeature)} subscription or higher`,
      );
    }

    return true;
  }

  private checkFeatureAccess(user: any, feature: Feature): boolean {
    const tier = user.subscriptionTier;
    const status = user.subscriptionStatus;

    // Check subscription is active
    if (status !== SubscriptionStatus.ACTIVE && status !== SubscriptionStatus.TRIALING) {
      return false;
    }

    switch (feature) {
      case Feature.CUSTOM_REPLIES:
        return [SubscriptionTier.STARTER, SubscriptionTier.PRO, SubscriptionTier.ENTERPRISE].includes(tier);

      case Feature.PHONE_CALLS:
        return [SubscriptionTier.PRO, SubscriptionTier.ENTERPRISE].includes(tier);

      case Feature.AI_FOLLOWUPS:
        return tier === SubscriptionTier.ENTERPRISE;

      case Feature.OWN_NUMBER:
        return user.hasOwnNumber === true;

      default:
        return false;
    }
  }

  private getRequiredTier(feature: Feature): string {
    switch (feature) {
      case Feature.CUSTOM_REPLIES:
        return 'Starter';
      case Feature.PHONE_CALLS:
        return 'Pro';
      case Feature.AI_FOLLOWUPS:
        return 'Enterprise';
      case Feature.OWN_NUMBER:
        return 'Own Number add-on';
      default:
        return 'Unknown';
    }
  }
}
