import { Body, Controller, Get, Post, UseGuards, BadRequestException } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OnboardingService, Step1Input, Step2Input } from './onboarding.service';

const VALID_PRIMARY_SOURCES = ['thumbtack', 'yelp', 'google', 'facebook', 'other'];
const VALID_VOLUMES = ['0-5', '5-15', '15-50', '50+'];
const VALID_SERVICE_TYPES = [
  'house_cleaning',
  'deep_cleaning',
  'move_out_cleaning',
  'commercial_cleaning',
  'other',
];

@Controller('v1/onboarding')
@UseGuards(JwtAuthGuard)
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Get('profile')
  async getProfile(@CurrentUser() user: any) {
    const profile = await this.onboardingService.getProfile(user.id);
    return { success: true, profile };
  }

  @Post('step1')
  async saveStep1(@CurrentUser() user: any, @Body() body: Step1Input) {
    if (!body.primaryLeadSource || !VALID_PRIMARY_SOURCES.includes(body.primaryLeadSource)) {
      throw new BadRequestException('Invalid primaryLeadSource');
    }
    if (!body.weeklyLeadVolume || !VALID_VOLUMES.includes(body.weeklyLeadVolume)) {
      throw new BadRequestException('Invalid weeklyLeadVolume');
    }
    if (!body.serviceType || !VALID_SERVICE_TYPES.includes(body.serviceType)) {
      throw new BadRequestException('Invalid serviceType');
    }
    if (body.serviceType === 'other' && !body.serviceTypeOther?.trim()) {
      throw new BadRequestException('serviceTypeOther is required when serviceType is "other"');
    }
    if (body.secondaryLeadSources) {
      const invalid = body.secondaryLeadSources.find(s => !VALID_PRIMARY_SOURCES.includes(s));
      if (invalid) throw new BadRequestException(`Invalid secondary source: ${invalid}`);
    }
    const profile = await this.onboardingService.saveStep1(user.id, body);
    return { success: true, profile };
  }

  @Post('step2')
  async saveStep2(@CurrentUser() user: any, @Body() body: Step2Input) {
    const profile = await this.onboardingService.saveStep2(user.id, body);
    return { success: true, profile };
  }

  @Post('step2/skip')
  async skipStep2(@CurrentUser() user: any) {
    const profile = await this.onboardingService.skipStep2(user.id);
    return { success: true, profile };
  }
}
