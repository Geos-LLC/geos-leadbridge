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
import { EmailService } from '../common/email/email.service';

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
    private email: EmailService,
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

    // Set 7-day trial period
    const now = new Date();
    const trialEndDate = new Date(now);
    trialEndDate.setDate(trialEndDate.getDate() + 7);

    // Normalize business phone to E.164 if provided
    const normalizedBusinessPhone = businessPhone
      ? this.normalizePhoneToE164(businessPhone)
      : undefined;

    // Create user with trial. trialType=TIME_BASED gives the user immediate
    // gate-passing for the 7-day window — needed for phone provisioning and
    // other access-gated actions during onboarding, before they connect any
    // platform.
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

    // Notify ops that a new tenant signed up. Non-blocking — a failed
    // notification never breaks signup. Goes to the admin alert mailbox
    // configured via env; defaults to info@geos-ai.com.
    this.sendNewTenantAdminEmail(user.id, user.email, user.name, normalizedBusinessPhone || null)
      .catch((err) => this.logger.warn(`[AdminNotify] new-tenant email failed for ${user.email}: ${err?.message || err}`));

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

    // Send via EmailService (SendGrid). Swallow errors so the API response
    // stays generic — surfacing "email failed" would leak account existence.
    try {
      await this.sendPasswordResetEmail(email, user.name || 'User', resetUrl);
    } catch (error) {
      this.logger.error(`[Auth] Failed to send password reset email to ${email}: ${(error as any)?.message || error}`);
    }

    return {
      message: 'If an account with that email exists, a password reset link has been sent.',
    };
  }

  /**
   * Send password reset email via SendGrid (was EmailJS pre-consolidation;
   * see EmailService for the why). The email is tenant-facing — different
   * from-name and tone than the ops alerts also routed through SendGrid.
   */
  private async sendPasswordResetEmail(toEmail: string, userName: string, resetUrl: string): Promise<void> {
    const safeName = userName?.trim() || 'there';
    const subject = 'Reset your LeadBridge password';
    const text =
      `Hi ${safeName},\n\n` +
      `We received a request to reset your LeadBridge password. Open the link below to choose a new one. This link expires in 1 hour.\n\n` +
      `${resetUrl}\n\n` +
      `If you didn't request a reset, you can ignore this email — your password stays the same.\n\n` +
      `— LeadBridge`;
    const html =
      `<p>Hi ${safeName},</p>` +
      `<p>We received a request to reset your LeadBridge password. Use the button below to choose a new one. This link expires in 1&nbsp;hour.</p>` +
      `<p><a href="${resetUrl}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600">Reset password</a></p>` +
      `<p>Or copy and paste this URL into your browser:<br><a href="${resetUrl}">${resetUrl}</a></p>` +
      `<p>If you didn't request a reset, you can ignore this email — your password stays the same.</p>` +
      `<p>— LeadBridge</p>`;

    await this.email.send({
      to: toEmail,
      subject,
      text,
      html,
      fromName: 'LeadBridge',
      tag: 'auth/password-reset',
    });
  }

  /**
   * Notify the ops mailbox that a new tenant just signed up. Recipient
   * resolves via ADMIN_ALERT_EMAIL → MONITORING_ALERT_EMAIL → the hard-
   * coded ops mailbox so it still fires if env wasn't set on this service.
   * From-name is "LeadBridge Ops" so deliverability and trust signals
   * stay separate from tenant-facing mail (auth/billing/etc.).
   */
  private async sendNewTenantAdminEmail(
    userId: string,
    email: string,
    name: string | null | undefined,
    businessPhone: string | null,
  ): Promise<void> {
    const to = process.env.ADMIN_ALERT_EMAIL || process.env.MONITORING_ALERT_EMAIL || 'info@geos-ai.com';
    const adminUrl = (process.env.FRONTEND_URL || 'https://www.leadbridge360.com').replace(/\/$/, '') + `/admin/users/${userId}`;

    const displayName = name?.trim() || '(no name)';
    const displayPhone = businessPhone || '(none)';
    const when = new Date().toISOString();

    const subject = `LeadBridge — new signup: ${displayName} <${email}>`;
    const text =
      `New tenant just signed up.\n\n` +
      `Name:    ${displayName}\n` +
      `Email:   ${email}\n` +
      `Phone:   ${displayPhone}\n` +
      `User ID: ${userId}\n` +
      `When:    ${when}\n\n` +
      `Admin view: ${adminUrl}\n`;
    const html =
      `<p>New tenant just signed up.</p>` +
      `<ul>` +
      `<li><strong>Name:</strong> ${displayName}</li>` +
      `<li><strong>Email:</strong> ${email}</li>` +
      `<li><strong>Phone:</strong> ${displayPhone}</li>` +
      `<li><strong>User ID:</strong> <code>${userId}</code></li>` +
      `<li><strong>When:</strong> ${when}</li>` +
      `</ul>` +
      `<p><a href="${adminUrl}">Open in admin dashboard</a></p>`;

    await this.email.send({
      to,
      subject,
      text,
      html,
      fromName: 'LeadBridge Ops',
      tag: 'auth/new-tenant-admin',
    });
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
