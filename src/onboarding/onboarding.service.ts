import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';

export interface Step1Input {
  primaryLeadSource: string;
  secondaryLeadSources?: string[];
  weeklyLeadVolume: string;
  serviceType: string;
  serviceTypeOther?: string;
}

export interface Step2Input {
  responseSpeed?: string;
  missedLeadOutcome?: string;
  avgJobValue?: string;
  userGoal?: string;
}

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(private prisma: PrismaService) {}

  async getProfile(userId: string) {
    const profile = await this.prisma.onboardingProfile.findUnique({
      where: { userId },
    });
    return profile;
  }

  async saveStep1(userId: string, input: Step1Input) {
    const now = new Date();
    const profile = await this.prisma.onboardingProfile.upsert({
      where: { userId },
      create: {
        userId,
        primaryLeadSource: input.primaryLeadSource,
        secondaryLeadSources: input.secondaryLeadSources ?? [],
        weeklyLeadVolume: input.weeklyLeadVolume,
        serviceType: input.serviceType,
        serviceTypeOther: input.serviceTypeOther ?? null,
        step1CompletedAt: now,
      },
      update: {
        primaryLeadSource: input.primaryLeadSource,
        secondaryLeadSources: input.secondaryLeadSources ?? [],
        weeklyLeadVolume: input.weeklyLeadVolume,
        serviceType: input.serviceType,
        serviceTypeOther: input.serviceTypeOther ?? null,
        step1CompletedAt: now,
      },
    });
    this.logger.log(`[Onboarding] Step 1 saved for user ${userId} — source=${input.primaryLeadSource}, volume=${input.weeklyLeadVolume}`);
    return profile;
  }

  async saveStep2(userId: string, input: Step2Input) {
    const now = new Date();
    const profile = await this.prisma.onboardingProfile.upsert({
      where: { userId },
      create: {
        userId,
        ...input,
        step2CompletedAt: now,
      },
      update: {
        ...input,
        step2CompletedAt: now,
        step2SkippedAt: null,
      },
    });
    this.logger.log(`[Onboarding] Step 2 saved for user ${userId}`);
    return profile;
  }

  async skipStep2(userId: string) {
    const now = new Date();
    const profile = await this.prisma.onboardingProfile.upsert({
      where: { userId },
      create: { userId, step2SkippedAt: now },
      update: { step2SkippedAt: now },
    });
    this.logger.log(`[Onboarding] Step 2 skipped for user ${userId}`);
    return profile;
  }

  async skipStep1(userId: string) {
    const now = new Date();
    const profile = await this.prisma.onboardingProfile.upsert({
      where: { userId },
      create: { userId, step1SkippedAt: now },
      update: { step1SkippedAt: now },
    });
    this.logger.log(`[Onboarding] Step 1 skipped for user ${userId}`);
    return profile;
  }
}
