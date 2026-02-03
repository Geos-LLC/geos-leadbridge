import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../common/utils/prisma.service';
import { SubscriptionTier, SubscriptionStatus } from '../../generated/prisma';

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private stripe: Stripe;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (!secretKey) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    this.stripe = new Stripe(secretKey, {
      apiVersion: '2026-01-28.clover',
    });
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

    // Get or create Stripe customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      this.logger.log(`[createCheckoutSession] Creating new Stripe customer`);
      const customer = await this.stripe.customers.create({
        email: user.email,
        metadata: { userId: user.id },
      });
      customerId = customer.id;
      this.logger.log(`[createCheckoutSession] Created customer: ${customerId}`);

      await this.prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId },
      });
    } else {
      this.logger.log(`[createCheckoutSession] Using existing customer: ${customerId}`);
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
    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'subscription',
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
      throw new BadRequestException('User has no Stripe customer');
    }

    const session = await this.stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${this.configService.get<string>('FRONTEND_URL')}/billing`,
    });

    return { portalUrl: session.url };
  }

  async handleWebhook(rawBody: Buffer, signature: string) {
    const webhookSecret =
      this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    }

    let event: Stripe.Event;

    try {
      event = this.stripe.webhooks.constructEvent(
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
        hasOwnNumber: true,
        stripeSubscriptionId: true,
      },
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    // Get features based on tier
    const features = this.getFeaturesForTier(user.subscriptionTier);

    return {
      tier: user.subscriptionTier,
      status: user.subscriptionStatus,
      periodEnd: user.subscriptionPeriodEnd,
      hasOwnNumber: user.hasOwnNumber,
      features,
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

    // Update user
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        stripeSubscriptionId: subscription.id,
        subscriptionTier: tier,
        subscriptionStatus: status,
        subscriptionPeriodEnd: new Date((subscription as any).current_period_end * 1000),
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

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionStatus: SubscriptionStatus.CANCELLED,
      },
    });

    await this.prisma.subscriptionHistory.create({
      data: {
        userId: user.id,
        tier: user.subscriptionTier!,
        status: SubscriptionStatus.CANCELLED,
        eventType: 'customer.subscription.deleted',
        stripeEventId: eventId,
        metadata: subscription as any,
      },
    });

    this.logger.log(`Subscription deleted for user ${user.id}`);
  }

  private async handleInvoicePaymentSucceeded(invoice: Stripe.Invoice) {
    const customerId = invoice.customer as string;
    const user = await this.prisma.user.findUnique({
      where: { stripeCustomerId: customerId },
    });

    const subscriptionId = (invoice as any).subscription;
    if (!user || !subscriptionId) return;

    // Update period end
    const subscription = await this.stripe.subscriptions.retrieve(
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
