/**
 * Authentication Service
 * Handles user registration, login, and JWT token management
 */

import { Injectable, UnauthorizedException, ConflictException, BadRequestException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../common/utils/prisma.service';
import { EncryptionUtil } from '../common/utils/encryption.util';
import { SigcoreService } from '../sigcore/sigcore.service';
import { CacheService } from '../common/cache/cache.service';
import { CacheKeys } from '../common/cache/cache-keys';
import { TrialService } from '../trial/trial.service';
import { TrialType } from '../../generated/prisma';
import * as crypto from 'crypto';
import emailjs from '@emailjs/nodejs';

const ME_TTL_SECONDS = 60;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private sigcoreService: SigcoreService,
    private cache: CacheService,
    private trialService: TrialService,
  ) {}

  /**
   * Invalidate the cached /auth/me payload for a user.
   * Callers must invoke this AFTER any DB mutation that changes the payload
   * (name, email, collectedLeads count), so readers never see pre-commit state.
   */
  async invalidateMeCache(userId: string): Promise<void> {
    await this.cache.del(CacheKeys.me(userId));
  }

  /**
   * Register a new user
   */
  async register(email: string, password: string, name?: string, businessPhone?: string) {
    // Check if user already exists
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    // Hash password
    const hashedPassword = await EncryptionUtil.hashPassword(password);

    // Set 14-day trial period
    const now = new Date();
    const trialEndDate = new Date(now);
    trialEndDate.setDate(trialEndDate.getDate() + 14);

    // Normalize business phone to E.164 if provided
    const normalizedBusinessPhone = businessPhone
      ? this.normalizePhoneToE164(businessPhone)
      : undefined;

    // Create user with trial. trialType=TIME_BASED gives the user immediate
    // gate-passing for the 14-day window — needed for phone provisioning and
    // other access-gated actions during onboarding, before they connect any
    // platform. onPlatformConnected later upgrades the type to LEAD_BASED /
    // HYBRID based on the actual platform mix (upgrade-only — won't shorten
    // the window or reduce the lead allowance).
    const user = await this.prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        businessPhone: normalizedBusinessPhone || null,
        trialType: TrialType.TIME_BASED,
        trialStartDate: now,
        trialEndDate: trialEndDate,
        trialUsed: false,
      },
    });

    // Register in Sigcore business identity model (non-blocking)
    this.sigcoreService.registerBusinessIdentity(user.id).catch(e => {
      this.logger.warn(`[BusinessIdentity] Registration deferred for user ${user.id}: ${e.message}`);
    });

    // Generate JWT token
    const token = this.generateToken(user.id, user.email);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        subscriptionTier: user.subscriptionTier,
        subscriptionStatus: user.subscriptionStatus,
        subscriptionPeriodEnd: user.subscriptionPeriodEnd,
        hasOwnNumber: user.hasOwnNumber,
        phoneNumber: user.phoneNumber,
        businessPhone: user.businessPhone,
        website: user.website ?? null,
        aiConversationEnabled: user.aiConversationEnabled,
        trialStartDate: user.trialStartDate,
        trialEndDate: user.trialEndDate,
        trialUsed: user.trialUsed,
        onboardingProfile: null,
      },
      token,
    };
  }

  /**
   * Login user
   */
  async login(email: string, password: string) {
    // Find user
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { onboardingProfile: true },
    });

    if (!user || !user.password) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Verify password
    const isPasswordValid = await EncryptionUtil.comparePassword(password, user.password);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Generate JWT token
    const token = this.generateToken(user.id, user.email);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        subscriptionTier: user.subscriptionTier,
        subscriptionStatus: user.subscriptionStatus,
        subscriptionPeriodEnd: user.subscriptionPeriodEnd,
        hasOwnNumber: user.hasOwnNumber,
        phoneNumber: user.phoneNumber,
        businessPhone: user.businessPhone,
        website: user.website ?? null,
        aiConversationEnabled: user.aiConversationEnabled,
        trialStartDate: user.trialStartDate,
        trialEndDate: user.trialEndDate,
        trialUsed: user.trialUsed,
        onboardingProfile: user.onboardingProfile,
      },
      token,
    };
  }

  /**
   * Get user profile
   */
  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        subscriptionTier: true,
        subscriptionStatus: true,
        subscriptionPeriodEnd: true,
        hasOwnNumber: true,
        phoneNumber: true,
        businessPhone: true,
        website: true,
        websiteMetadataJson: true,
        aiConversationEnabled: true,
        createdAt: true,
        // Trial fields — used to compute `trialActive` so the frontend can
        // unlock Engage/Convert features for trial users without an extra
        // /v1/billing/subscription fetch on every page mount.
        trialType: true,
        trialEndedAt: true,
        trialEndDate: true,
        trialLeadsHandled: true,
        trialLeadsLimit: true,
        platforms: {
          select: {
            platformName: true,
            connected: true,
            lastSyncAt: true,
          },
        },
        onboardingProfile: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Reuse the canonical trial-active logic (paid sub OR active adaptive
    // trial). Frontend gates use this to unlock Engage/Convert features
    // during trial — same semantics as canProcessLead's 'trial' branch.
    const trialView = this.trialService.buildTrialView(user);

    return { ...user, trialActive: trialView.isActive };
  }

  /**
   * Get account info for Chrome extension verification.
   * Returns { ok, account, stats } format expected by the extension.
   */
  async getMe(userId: string) {
    return this.cache.getOrSet(CacheKeys.me(userId), ME_TTL_SECONDS, async () => {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true },
      });

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      const collectedLeads = await this.prisma.thumbtackLeadId.count({
        where: { userId },
      });

      return {
        ok: true,
        account: {
          tenantId: user.id,
          name: user.name || user.email,
          email: user.email,
        },
        stats: { collectedLeads },
      };
    });
  }

  private normalizePhoneToE164(phone: string): string | null {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    if (digits.length > 10) return `+${digits}`;
    return null;
  }

  /**
   * Generate JWT token
   */
  private generateToken(userId: string, email: string): string {
    const payload = { sub: userId, email };
    return this.jwtService.sign(payload);
  }

  /**
   * Request password reset
   * Generates a reset token and stores it with expiry
   */
  async forgotPassword(email: string) {
    console.log(`[Auth] forgotPassword called for email: ${email}`);

    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    // Always return success to prevent email enumeration
    if (!user) {
      console.log(`[Auth] No user found for email: ${email}`);
      return {
        message: 'If an account with that email exists, a password reset link has been sent.',
      };
    }

    console.log(`[Auth] User found: ${user.id}`)

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Store hashed token
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken: hashedToken,
        passwordResetExpires: expires,
      },
    });

    // Build reset URL
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}`;
    console.log(`[Auth] Reset URL generated: ${resetUrl}`);

    // Send email via EmailJS
    console.log(`[Auth] About to send email via EmailJS...`);
    console.log(`[Auth] EMAILJS_PUBLIC_KEY configured: ${!!process.env.EMAILJS_PUBLIC_KEY}`);
    console.log(`[Auth] EMAILJS_PRIVATE_KEY configured: ${!!process.env.EMAILJS_PRIVATE_KEY}`);
    try {
      await this.sendPasswordResetEmail(email, user.name || 'User', resetUrl);
      console.log(`[Auth] Password reset email sent successfully to ${email}`);
    } catch (error) {
      console.error(`[Auth] Failed to send password reset email to ${email}:`, error);
      // Still return success to prevent email enumeration
    }
    console.log(`[Auth] forgotPassword completed`);

    return {
      message: 'If an account with that email exists, a password reset link has been sent.',
    };
  }

  /**
   * Send password reset email via EmailJS
   */
  private async sendPasswordResetEmail(toEmail: string, userName: string, resetUrl: string) {
    console.log(`[Auth] sendPasswordResetEmail called`);
    const publicKey = process.env.EMAILJS_PUBLIC_KEY;
    const privateKey = process.env.EMAILJS_PRIVATE_KEY;

    console.log(`[Auth] Public key length: ${publicKey?.length || 0}`);
    console.log(`[Auth] Private key length: ${privateKey?.length || 0}`);

    if (!publicKey) {
      console.error(`[Auth] EMAILJS_PUBLIC_KEY is missing!`);
      throw new Error('EMAILJS_PUBLIC_KEY is not configured');
    }

    console.log(`[Auth] Calling emailjs.send with:`, {
      serviceId: 'service_hkfn8t9',
      templateId: 'template_zk3lz5s',
      toEmail,
      userName,
    });

    const result = await emailjs.send(
      'service_hkfn8t9',
      'template_zk3lz5s',
      {
        to_email: toEmail,
        name: userName,
        reset_url: resetUrl,
      },
      {
        publicKey,
        privateKey,
      },
    );

    console.log(`[Auth] EmailJS response:`, result);
    return result;
  }

  /**
   * Reset password using token
   */
  async resetPassword(token: string, newPassword: string) {
    if (!token || !newPassword) {
      throw new BadRequestException('Token and new password are required');
    }

    if (newPassword.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
    }

    // Hash the provided token to compare with stored hash
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // Find user with valid token
    const user = await this.prisma.user.findFirst({
      where: {
        passwordResetToken: hashedToken,
        passwordResetExpires: {
          gt: new Date(),
        },
      },
    });

    if (!user) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    // Hash new password
    const hashedPassword = await EncryptionUtil.hashPassword(newPassword);

    // Update password and clear reset token
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        passwordResetToken: null,
        passwordResetExpires: null,
      },
    });

    return {
      message: 'Password has been reset successfully. You can now log in with your new password.',
    };
  }

  /**
   * Change password for authenticated user
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    if (!currentPassword || !newPassword) {
      throw new BadRequestException('Current password and new password are required');
    }

    if (newPassword.length < 8) {
      throw new BadRequestException('New password must be at least 8 characters');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.password) {
      throw new UnauthorizedException('User not found');
    }

    const isCurrentValid = await EncryptionUtil.comparePassword(currentPassword, user.password);
    if (!isCurrentValid) {
      throw new BadRequestException('Current password is incorrect');
    }

    const hashedPassword = await EncryptionUtil.hashPassword(newPassword);

    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    return { message: 'Password changed successfully' };
  }
}
