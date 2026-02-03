import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Res,
  UseGuards,
  Headers,
  RawBodyRequest,
} from '@nestjs/common';
import { StripeService } from './stripe.service';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Public } from '../common/decorators/public.decorator';
import { Request, Response } from 'express';

@Controller('v1/stripe')
export class StripeController {
  constructor(private readonly stripeService: StripeService) {}

  @Post('create-checkout-session')
  @UseGuards(JwtAuthGuard)
  async createCheckoutSession(
    @Req() req: any,
    @Body() dto: CreateCheckoutSessionDto,
  ) {
    console.log('[StripeController] Received checkout request');
    console.log('[StripeController] User ID:', req.user?.id);
    console.log('[StripeController] DTO:', JSON.stringify(dto));
    console.log('[StripeController] Tier:', dto.tier);
    console.log('[StripeController] AddOns:', dto.addOns);

    const userId = req.user.id;
    const result = await this.stripeService.createCheckoutSession(
      userId,
      dto.tier,
      dto.addOns,
    );
    return {
      success: true,
      data: result,
    };
  }

  @Post('create-portal-session')
  @UseGuards(JwtAuthGuard)
  async createPortalSession(@Req() req: any) {
    const userId = req.user.id;
    const result = await this.stripeService.createBillingPortalSession(userId);
    return {
      success: true,
      data: result,
    };
  }

  @Get('subscription')
  @UseGuards(JwtAuthGuard)
  async getSubscription(@Req() req: any, @Res() res: Response) {
    const userId = req.user.id;
    const result = await this.stripeService.getSubscriptionDetails(userId);

    // Prevent caching so subscription changes are reflected immediately
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    return res.json({
      success: true,
      data: result,
    });
  }

  @Public()
  @Post('webhook')
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new Error('Raw body is required for webhook signature verification');
    }

    const result = await this.stripeService.handleWebhook(rawBody, signature);
    return result;
  }
}
