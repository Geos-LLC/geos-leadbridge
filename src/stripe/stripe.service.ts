import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../common/utils/prisma.service';
import { SubscriptionTier, SubscriptionStatus } from '../../generated/prisma';
import { TrialService } from '../trial/trial.service';

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private stripe: Stripe | null = null;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    private trialService: TrialService,
  ) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (secretKey) {
      this.stripe = new Stripe(secretKey, {
        apiVersion: '2026-01-28.clover',
      });
    } else {
      this.logger.warn('STRIPE_SECRET_KEY is not configured — Stripe features disabled');
    }
  }

  private requireStripe(): Stripe {
    if (!this.stripe) {
      throw new BadRequestException('Stripe is not configured');
    }
    return this.stripe;
  }

  async createCheckoutSession(
    userId: string,
    tier: SubscriptionTier,
    addOns: string[] = [],
  ) {
    this.logger.log(`[createCheckoutSession] Starting for userId: ${userId}, tier: ${tier}`);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      this.logger.error(`[createCheckoutSession] User not found: ${userId}`);
      throw new BadRequestException('User not found');
    }
    this.logger.log(`[createCheckoutSession] User found: ${user.email}`);

    // Get or create Stripe customer (validates existing ID is in the correct mode)
    let customerId = user.stripeCustomerId;
    if (customerId) {
      try {
        await this.requireStripe().customers.retrieve(customerId);
        this.logger.log(`[createCheckoutSession] Using existing customer: ${customerId}`);
      } catch (err: any) {
        this.logger.warn(`[createCheckoutSession] Stale customer ID ${customerId}: ${err.message} — creating new`);
        customerId = null;
        await this.prisma.user.update({ where: { id: userId }, data: { stripeCustomerId: null } });
      }
    }
    if (!customerId) {
      this.logger.log(`[createCheckoutSession] Creating new Stripe customer`);
      const customer = await this.requireStripe().customers.create({
        email: user.email,
        metadata: { userId: user.id },
      });
      customerId = customer.id;
      this.logger.log(`[createCheckoutSession] Created customer: ${customerId}`);
      await this.prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId },
      });
    }

    // Build line items
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];

    // Add tier price
    const tierPriceId = this.getPriceIdForTier(tier);
    this.logger.log(`[createCheckoutSession] Tier price ID: ${tierPriceId}`);
    lineItems.push({ price: tierPriceId, quantity: 1 });

    // Add add-ons
    if (addOns.includes('ownNumber')) {
      const ownNumberPriceId =
        this.configService.get<string>('STRIPE_PRICE_OWN_NUMBER');
      if (ownNumberPriceId) {
        this.logger.log(`[createCheckoutSession] Adding own number: ${ownNumberPriceId}`);
        lineItems.push({ price: ownNumberPriceId, quantity: 1 });
      }
    }

    // Create checkout session
    this.logger.log(`[createCheckoutSession] Creating checkout session with ${lineItems.length} line items`);
    const session = await this.requireStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'subscription',
      allow_promotion_codes: true,
      success_url: `${this.configService.get<string>('FRONTEND_URL')}/billing?success=true`,
      cancel_url: `${this.configService.get<string>('FRONTEND_URL')}/pricing?canceled=true`,
      metadata: {
        userId: user.id,
        tier,
        addOns: JSON.stringify(addOns),
      },
    });

    this.logger.log(`[createCheckoutSession] Session created: ${session.id}, URL: ${session.url}`);
    return { sessionUrl: session.url };
  }

  async createBillingPortalSession(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.stripeCustomerId) {
      const frontendUrl = this.configService.get<string>('FRONTEND_URL');
      return { portalUrl: `${frontendUrl}/pricing` };
    }

    try {
      const session = await this.requireStripe().billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: `${this.configService.get<string>('FRONTEND_URL')}/billing`,
      });
      return { portalUrl: session.url };
    } catch (err: any) {
      this.logger.error(`[createBillingPortalSession] Stripe error: ${err.message}`);
      // Stale customer ID (e.g. test-mode customer used with live keys) — clear it and send to pricing
      if (err.code === 'resource_missing' || err.message?.includes('No such customer')) {
        await this.prisma.user.update({
          where: { id: userId },
          data: { stripeCustomerId: null },
        });
        const frontendUrl = this.configService.get<string>('FRONTEND_URL');
        return { portalUrl: `${frontendUrl}/pricing` };
      }
      throw new BadRequestException(err.message || 'Failed to create billing portal session');
    }
  }

  async cancelSubscription(userId: string, immediate: boolean = true) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('User not found');
    }

    if (!user.stripeSubscriptionId) {
      throw new BadRequestException('User has no active subscription');
    }

    this.logger.log(`[cancelSubscription] Cancelling subscription ${user.stripeSubscriptionId} for user ${userId}, immediate: ${immediate}`);

    if (immediate) {
      // Cancel immediately
      await this.requireStripe().subscriptions.cancel(user.stripeSubscriptionId);
      this.logger.log(`[cancelSubscription] Subscription cancelled immediately`);

      // Clear subscription data immediately (webhook will also run, but this gives instant feedback)
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          stripeSubscriptionId: null,
          subscriptionTier: null,
          subscriptionStatus: null,
          subscriptionPeriodEnd: null,
          hasOwnNumber: false,
        },
      });
      this.logger.log(`[cancelSubscription] User subscription data cleared`);
    } else {
      // Cancel at period end
      await this.requireStripe().subscriptions.update(user.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });
      this.logger.log(`[cancelSubscription] Subscription set to cancel at period end`);
    }

    return { success: true, immediate };
  }

  async handleWebhook(rawBody: Buffer, signature: string) {
    const webhookSecret =
      this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    }

    let event: Stripe.Event;

    try {
      event = this.requireStripe().webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret,
      );
    } catch (err) {
      this.logger.error(`Webhook signature verification failed: ${err.message}`);
      throw new BadRequestException('Invalid signature');
    }

    this.logger.log(`Processing webhook event: ${event.type}`);

    try {
      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
          await this.handleSubscriptionUpdate(event.data.object as Stripe.Subscription, event.id, event.type);
          break;

        case 'customer.subscription.deleted':
          await this.handleSubscriptionDeleted(event.data.object as Stripe.Subscription, event.id);
          break;

        case 'invoice.payment_succeeded':
          await this.handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice);
          break;

        case 'invoice.payment_failed':
          await this.handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
          break;

        default:
          this.logger.log(`Unhandled event type: ${event.type}`);
      }

      return { received: true };
    } catch (error) {
      this.logger.error(`Error processing webhook: ${error.message}`);
      throw error;
    }
  }

  async getSubscriptionDetails(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        subscriptionTier: true,
        subscriptionStatus: true,
        subscriptionPeriodEnd: true,
        cancelAtPeriodEnd: true,
        hasOwnNumber: true,
        stripeSubscriptionId: true,
        trialStartDate: true,
        trialEndDate: true,
        trialUsed: true,
        trialLeadsHandled: true,
        trialLeadsLimit: true,
        trialType: true,
        trialEndedAt: true,
      },
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    const tier = user.subscriptionTier;
    const status = user.subscriptionStatus;
    const features = status === SubscriptionStatus.CANCELLED || !tier ? [] : this.getFeaturesForTier(tier);

    const view = this.trialService.buildTrialView({
      subscriptionTier: tier,
      trialType: user.trialType,
      trialEndDate: user.trialEndDate,
      trialEndedAt: user.trialEndedAt,
      trialLeadsHandled: user.trialLeadsHandled,
      trialLeadsLimit: user.trialLeadsLimit,
    });

    return {
      tier,
      status,
      periodEnd: user.subscriptionPeriodEnd,
      cancelAtPeriodEnd: user.cancelAtPeriodEnd || false,
      hasOwnNumber: user.hasOwnNumber || false,
      features,
      trial: {
        // Adaptive view (preferred for new UI)
        type: view.trialType,
        isActive: view.isActive,
        isEnded: view.isEnded,
        daysRemaining: view.daysRemaining,
        leadsHandled: view.leadsHandled,
        leadsLimit: view.leadsLimit,
        leadsRemaining: view.leadsRemaining,
        endDate: view.endDate,
        endedAt: view.endedAt,
        label: view.label,
        progress: view.progress,

        // Legacy fields kept for back-compat with existing TrialBanner /
        // TrialExpiredModal until they're swapped to the adaptive view.
        isOnTrial: view.isActive,
        trialExpired: view.isEnded,
        trialExpiredByTime: view.trialType !== null && !view.isActive && view.daysRemaining === 0,
        trialExpiredByUsage: view.trialType !== null && view.leadsRemaining === 0,
        trialDaysRemaining: view.daysRemaining ?? 0,
        trialEndDate: view.endDate,
        trialLeadsHandled: view.leadsHandled,
        trialLeadsLimit: view.leadsLimit,
        trialLeadsRemaining: view.leadsRemaining,
      },
    };
  }

  // Private helper methods

  private async handleSubscriptionUpdate(subscription: Stripe.Subscription, eventId: string, eventType: string) {
    const customerId = subscription.customer as string;
    this.logger.log(`[handleSubscriptionUpdate] Processing subscription ${subscription.id} for customer ${customerId}, event: ${eventId}`);

    const user = await this.prisma.user.findUnique({
      where: { stripeCustomerId: customerId },
    });

    if (!user) {
      this.logger.warn(`[handleSubscriptionUpdate] User not found for customer: ${customerId}`);
      return;
    }

    this.logger.log(`[handleSubscriptionUpdate] Found user: ${user.email} (${user.id})`);

    // Determine tier and add-ons from subscription items
    const tier = this.getTierFromSubscription(subscription);
    const hasOwnNumber = this.hasOwnNumberAddon(subscription);
    const status = this.mapStripeStatus(subscription.status);

    this.logger.log(`[handleSubscriptionUpdate] Subscription details - Tier: ${tier}, Status: ${status}, HasOwnNumber: ${hasOwnNumber}`);

    // Get current_period_end from subscription items (newer Stripe API structure)
    const periodEndTimestamp = subscription.items?.data?.[0]?.current_period_end
      || (subscription as any).current_period_end;
    const subscriptionPeriodEnd = periodEndTimestamp
      ? new Date(periodEndTimestamp * 1000)
      : null;

    this.logger.log(`[handleSubscriptionUpdate] Period end timestamp: ${periodEndTimestamp}, Date: ${subscriptionPeriodEnd}`);

    // Update user
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        stripeSubscriptionId: subscription.id,
        subscriptionTier: tier,
        subscriptionStatus: status,
        subscriptionPeriodEnd,
        cancelAtPeriodEnd: subscription.cancel_at_period_end || false,
        hasOwnNumber,
      },
    });

    this.logger.log(`[handleSubscriptionUpdate] User updated in database`);

    // Log subscription history
    await this.prisma.subscriptionHistory.create({
      data: {
        userId: user.id,
        tier,
        status,
        eventType,
        stripeEventId: eventId,
        metadata: subscription as any,
      },
    });

    this.logger.log(`[handleSubscriptionUpdate] Updated subscription for user ${user.id}: ${tier} - ${status}`);
  }

  private async handleSubscriptionDeleted(subscription: Stripe.Subscription, eventId: string) {
    const customerId = subscription.customer as string;
    const user = await this.prisma.user.findUnique({
      where: { stripeCustomerId: customerId },
    });

    if (!user) return;

    // Save tier before updating
    const previousTier = user.subscriptionTier;

    // Keep subscription info but mark as CANCELLED
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionStatus: SubscriptionStatus.CANCELLED,
        cancelAtPeriodEnd: false,
      },
    });

    await this.prisma.subscriptionHistory.create({
      data: {
        userId: user.id,
        tier: previousTier!,
        status: SubscriptionStatus.CANCELLED,
        eventType: 'customer.subscription.deleted',
        stripeEventId: eventId,
        metadata: subscription as any,
      },
    });

    this.logger.log(`Subscription deleted for user ${user.id}, all subscription data cleared`);
  }

  private async handleInvoicePaymentSucceeded(invoice: Stripe.Invoice) {
    const customerId = invoice.customer as string;
    const user = await this.prisma.user.findUnique({
      where: { stripeCustomerId: customerId },
    });

    const subscriptionId = (invoice as any).subscription;
    if (!user || !subscriptionId) return;

    // Update period end
    const subscription = await this.requireStripe().subscriptions.retrieve(
      subscriptionId as string,
    );

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionPeriodEnd: new Date((subscription as any).current_period_end * 1000),
      },
    });

    this.logger.log(`Payment succeeded for user ${user.id}`);
  }

  private async handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
    const customerId = invoice.customer as string;
    const user = await this.prisma.user.findUnique({
      where: { stripeCustomerId: customerId },
    });

    if (!user) return;

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionStatus: SubscriptionStatus.PAST_DUE,
      },
    });

    this.logger.warn(`Payment failed for user ${user.id}`);
  }

  private getTierFromSubscription(subscription: Stripe.Subscription): SubscriptionTier {
    const priceId = subscription.items.data[0]?.price.id;

    if (priceId === this.configService.get('STRIPE_PRICE_STARTER')) {
      return SubscriptionTier.STARTER;
    } else if (priceId === this.configService.get('STRIPE_PRICE_PRO')) {
      return SubscriptionTier.PRO;
    } else if (priceId === this.configService.get('STRIPE_PRICE_ENTERPRISE')) {
      return SubscriptionTier.ENTERPRISE;
    }

    return SubscriptionTier.STARTER; // Default fallback
  }

  private hasOwnNumberAddon(subscription: Stripe.Subscription): boolean {
    const ownNumberPriceId = this.configService.get('STRIPE_PRICE_OWN_NUMBER');
    return subscription.items.data.some((item) => item.price.id === ownNumberPriceId);
  }

  private mapStripeStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
    switch (status) {
      case 'active':
        return SubscriptionStatus.ACTIVE;
      case 'past_due':
        return SubscriptionStatus.PAST_DUE;
      case 'canceled':
        return SubscriptionStatus.CANCELLED;
      case 'trialing':
        return SubscriptionStatus.TRIALING;
      case 'incomplete':
      case 'incomplete_expired':
      case 'unpaid':
      case 'paused':
        return SubscriptionStatus.INCOMPLETE;
      default:
        return SubscriptionStatus.INCOMPLETE;
    }
  }

  private getPriceIdForTier(tier: SubscriptionTier): string {
    switch (tier) {
      case SubscriptionTier.STARTER:
        return this.configService.get<string>('STRIPE_PRICE_STARTER')!;
      case SubscriptionTier.PRO:
        return this.configService.get<string>('STRIPE_PRICE_PRO')!;
      case SubscriptionTier.ENTERPRISE:
        return this.configService.get<string>('STRIPE_PRICE_ENTERPRISE')!;
      default:
        throw new BadRequestException('Invalid subscription tier');
    }
  }

  private getFeaturesForTier(tier: SubscriptionTier | null): string[] {
    if (!tier) return [];

    const features = {
      [SubscriptionTier.STARTER]: [
        'Custom reply templates',
        'Unlimited leads',
        'Email notifications',
        'Basic analytics',
      ],
      [SubscriptionTier.PRO]: [
        'Everything in Starter',
        'Phone call capability',
        'SMS notifications',
        'Advanced analytics',
      ],
      [SubscriptionTier.ENTERPRISE]: [
        'Everything in Pro',
        'AI-powered follow-ups',
        'Priority support',
        'Custom integrations',
      ],
    };

    return features[tier] || [];
  }
}
