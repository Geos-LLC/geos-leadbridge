/**
 * Call Connect Service
 * Manages Instant Call Connect settings and triggers via Sigcore API
 */

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { PrismaService } from '../common/utils/prisma.service';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'crypto';

export interface SaveCallConnectSettingsDto {
  enabled?: boolean;
  mode?: 'AGENT_FIRST' | 'PARALLEL';
  agentStrategy?: 'owner' | 'round_robin' | 'on_duty';
  agentPhoneE164?: string;
  botNumberE164?: string;
  maxAgentAttempts?: number;
  quietHoursEnabled?: boolean;
  quietHoursTimezone?: string;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  agentAcceptDigits?: string;
  agentWhisperMessage?: string;
  leadGreetingMessage?: string;
  leadVoicemailEnabled?: boolean;
  leadVoicemailMessage?: string;
  leadVoicemailRecordingUrl?: string;
}

@Injectable()
export class CallConnectService {
  private readonly logger = new Logger(CallConnectService.name);
  private readonly sigcoreApiUrl: string;
  private readonly appBaseUrl: string;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private httpService: HttpService,
  ) {
    const rawUrl =
      this.configService.get<string>('SIGCORE_API_URL') ||
      'https://sigcore-production.up.railway.app/api';
    // Strip trailing /api — we build full paths ourselves using /api/internal/...
    this.sigcoreApiUrl = rawUrl.replace(/\/api\/?$/, '');

    const rawBaseUrl =
      this.configService.get<string>('APP_BASE_URL') ||
      this.configService.get<string>('FRONTEND_URL') ||
      'https://leadbridge360.com';
    this.appBaseUrl = rawBaseUrl.trim();
  }

  // ─── Tier gating ────────────────────────────────────────────────────────────

  canUseCallConnect(_userId: string): boolean {
    return true; // All tiers can use call connect
  }

  // ─── Settings CRUD ───────────────────────────────────────────────────────────

  async getSettings(savedAccountId: string) {
    return this.prisma.callConnectSettings.findUnique({
      where: { savedAccountId },
    });
  }

  async saveSettings(
    userId: string,
    savedAccountId: string,
    dto: SaveCallConnectSettingsDto,
  ) {
    const settings = await this.prisma.callConnectSettings.upsert({
      where: { savedAccountId },
      create: {
        savedAccountId,
        userId,
        enabled: dto.enabled ?? false,
        mode: (dto.mode as any) ?? 'AGENT_FIRST',
        agentStrategy: dto.agentStrategy ?? 'owner',
        agentPhoneE164: dto.agentPhoneE164,
        botNumberE164: dto.botNumberE164,
        maxAgentAttempts: dto.maxAgentAttempts ?? 2,
        quietHoursEnabled: dto.quietHoursEnabled ?? false,
        quietHoursTimezone: dto.quietHoursTimezone,
        quietHoursStart: dto.quietHoursStart,
        quietHoursEnd: dto.quietHoursEnd,
        agentAcceptDigits: dto.agentAcceptDigits ?? '0123456789*#',
        agentWhisperMessage: dto.agentWhisperMessage,
        leadGreetingMessage: dto.leadGreetingMessage,
        leadVoicemailEnabled: dto.leadVoicemailEnabled ?? false,
        leadVoicemailMessage: dto.leadVoicemailMessage,
        leadVoicemailRecordingUrl: dto.leadVoicemailRecordingUrl,
      },
      update: {
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        ...(dto.mode && { mode: dto.mode as any }),
        ...(dto.agentStrategy && { agentStrategy: dto.agentStrategy }),
        ...(dto.agentPhoneE164 !== undefined && { agentPhoneE164: dto.agentPhoneE164 }),
        ...(dto.botNumberE164 !== undefined && { botNumberE164: dto.botNumberE164 }),
        ...(dto.maxAgentAttempts !== undefined && { maxAgentAttempts: dto.maxAgentAttempts }),
        ...(dto.quietHoursEnabled !== undefined && { quietHoursEnabled: dto.quietHoursEnabled }),
        ...(dto.quietHoursTimezone !== undefined && { quietHoursTimezone: dto.quietHoursTimezone }),
        ...(dto.quietHoursStart !== undefined && { quietHoursStart: dto.quietHoursStart }),
        ...(dto.quietHoursEnd !== undefined && { quietHoursEnd: dto.quietHoursEnd }),
        ...(dto.agentAcceptDigits !== undefined && { agentAcceptDigits: dto.agentAcceptDigits }),
        ...(dto.agentWhisperMessage !== undefined && { agentWhisperMessage: dto.agentWhisperMessage }),
        ...(dto.leadGreetingMessage !== undefined && { leadGreetingMessage: dto.leadGreetingMessage }),
        ...(dto.leadVoicemailEnabled !== undefined && { leadVoicemailEnabled: dto.leadVoicemailEnabled }),
        ...(dto.leadVoicemailMessage !== undefined && { leadVoicemailMessage: dto.leadVoicemailMessage }),
        ...(dto.leadVoicemailRecordingUrl !== undefined && { leadVoicemailRecordingUrl: dto.leadVoicemailRecordingUrl }),
      },
    });

    // Push settings to Sigcore (best effort)
    try {
      await this.pushSettingsToSigcore(savedAccountId, settings);
    } catch (err: any) {
      this.logger.warn(`Failed to push call-connect settings to Sigcore: ${err.message}`);
    }

    // Ensure webhook subscription exists — always attempt so stale/missing IDs get fixed
    try {
      await this.ensureWebhookSubscription(savedAccountId, settings.id);
    } catch (err: any) {
      this.logger.warn(`Failed to register Sigcore call-connect webhook: ${err.message}`);
    }

    return settings;
  }

  // ─── Template variable substitution ─────────────────────────────────────────

  private substituteVars(
    template: string,
    vars: { customerName?: string; category?: string; location?: string },
  ): string {
    return template
      .replace(/\{customerName\}/g, vars.customerName || '')
      .replace(/\{category\}/g, vars.category || '')
      .replace(/\{location\}/g, vars.location || '');
  }

  // ─── Sigcore API ─────────────────────────────────────────────────────────────

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
    };
  }

  /** Get Sigcore API key — env-level first (authoritative), then account-level fallback */
  private async getSigcoreApiKey(savedAccountId: string): Promise<string | null> {
    const envKey = this.configService.get<string>('SIGCORE_API_KEY');
    if (envKey) return envKey;
    const ns = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
      select: { sigcoreApiKey: true },
    });
    return ns?.sigcoreApiKey || null;
  }

  /** Push call-connect settings to Sigcore */
  private async pushSettingsToSigcore(savedAccountId: string, settings: any): Promise<void> {
    const apiKey = await this.getSigcoreApiKey(savedAccountId);
    if (!apiKey) return;

    const url = `${this.sigcoreApiUrl}/api/internal/call-connect/settings`;
    await firstValueFrom(
      this.httpService.post(
        url,
        {
          enabled: settings.enabled,
          mode: settings.mode,
          botNumberE164: settings.botNumberE164,
          agentPhoneE164: settings.agentPhoneE164,
          ringTimeoutSeconds: 60,
          maxAgentAttempts: settings.maxAgentAttempts,
          agentAcceptDigits: settings.agentAcceptDigits || '0123456789*#',
          agentVoicemailMode: 'TTS',
          ...(settings.agentWhisperMessage && { agentWhisperMessage: settings.agentWhisperMessage }),
          ...(settings.leadGreetingMessage && { leadGreetingMessage: settings.leadGreetingMessage }),
          leadVoicemailEnabled: settings.leadVoicemailEnabled ?? false,
          ...(settings.leadVoicemailMessage && { leadVoicemailMessage: settings.leadVoicemailMessage }),
          ...(settings.leadVoicemailRecordingUrl && { leadVoicemailRecordingUrl: settings.leadVoicemailRecordingUrl }),
          ...(settings.quietHoursEnabled && settings.quietHoursTimezone && settings.quietHoursStart && settings.quietHoursEnd && {
            quietHours: {
              timezone: settings.quietHoursTimezone,
              start: settings.quietHoursStart,
              end: settings.quietHoursEnd,
            },
          }),
        },
        { headers: this.buildHeaders(apiKey) },
      ),
    );

    this.logger.log(`Pushed call-connect settings to Sigcore for account ${savedAccountId}`);
  }

  /** Register per-business webhook subscription with Sigcore */
  private async ensureWebhookSubscription(savedAccountId: string, settingsId: string): Promise<void> {
    const apiKey = await this.getSigcoreApiKey(savedAccountId);
    if (!apiKey) return;

    const settings = await this.prisma.callConnectSettings.findUnique({
      where: { id: settingsId },
      select: { sigcoreWebhookId: true, sigcoreWebhookSecret: true },
    });

    // Already registered — skip to avoid duplicate subscriptions
    if (settings?.sigcoreWebhookId) {
      this.logger.log(`Sigcore webhook already registered (id: ${settings.sigcoreWebhookId}) for account ${savedAccountId}`);
      return;
    }

    // Include accountId as query param so webhook handler can look up per-business secret
    const webhookUrl = `${this.appBaseUrl}/api/webhooks/sigcore/call-connect?accountId=${savedAccountId}`;
    const secret = settings?.sigcoreWebhookSecret || crypto.randomBytes(32).toString('hex');

    const url = `${this.sigcoreApiUrl}/api/webhooks/subscriptions`;
    const response = await firstValueFrom(
      this.httpService.post(
        url,
        {
          name: 'LeadBridge Call Connect',
          webhookUrl,
          secret,
          events: [
            'call_connect.session.created',
            'call_connect.agent.ringing',
            'call_connect.agent.accepted',
            'call_connect.lead.ringing',
            'call_connect.bridged',
            'call_connect.voicemail_drop',
            'call_connect.ended',
            'call_connect.failed',
          ],
        },
        { headers: this.buildHeaders(apiKey) },
      ),
    );

    const webhookId = response.data?.id || response.data?.webhookId;

    await this.prisma.callConnectSettings.update({
      where: { id: settingsId },
      data: {
        sigcoreWebhookId: webhookId || null,
        // Store generated secret if it wasn't already set
        ...(!settings?.sigcoreWebhookSecret && { sigcoreWebhookSecret: secret }),
      },
    });

    if (webhookId) {
      this.logger.log(`Registered Sigcore call-connect webhook: ${webhookId} for account ${savedAccountId}`);
    }
  }

  // ─── Trigger on new lead ─────────────────────────────────────────────────────

  /**
   * Called when a new lead arrives. Checks settings and triggers Sigcore if enabled.
   * Cooldown: skip if a session was started for this lead in the last 30 minutes.
   */
  async triggerForLead(params: {
    userId: string;
    savedAccountId: string | null;
    businessId: string | null;
    leadId: string;
    customerPhone: string | null;
    customerName: string;
    category?: string | null;
    location?: string | null;
    leadSummary?: string;
  }): Promise<void> {
    if (!params.savedAccountId || !params.customerPhone) return;

    // Check settings
    const settings = await this.prisma.callConnectSettings.findUnique({
      where: { savedAccountId: params.savedAccountId },
    });
    if (!settings?.enabled) return;

    // Get API key from NotificationSettings (single source of truth)
    const ns = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId: params.savedAccountId },
      select: { sigcoreApiKey: true, sigcoreWorkspaceId: true },
    });
    const sigcoreApiKey =
      this.configService.get<string>('SIGCORE_API_KEY') || ns?.sigcoreApiKey || null;
    if (!sigcoreApiKey) {
      this.logger.log('Skipping call-connect — no Sigcore API key configured');
      return;
    }

    // Tier check
    if (!this.canUseCallConnect(params.userId)) return;

    // Cooldown: don't trigger if there's already a session for this lead in last 30 min
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    const recentSession = await this.prisma.leadCallConnect.findFirst({
      where: {
        leadId: params.leadId,
        createdAt: { gte: thirtyMinAgo },
      },
    });
    if (recentSession) {
      this.logger.log(`Skipping call-connect for lead ${params.leadId} — recent session exists`);
      return;
    }

    // Resolve workspace/business ID from NotificationSettings
    const sigcoreBusinessId = ns?.sigcoreWorkspaceId || params.businessId || params.savedAccountId;

    const summary =
      params.leadSummary ||
      [params.customerName, params.category].filter(Boolean).join(' – ');

    try {
      const url = `${this.sigcoreApiUrl}/api/internal/call-connect/start`;

      const response = await firstValueFrom(
        this.httpService.post(
          url,
          {
            businessId: sigcoreBusinessId,
            leadId: params.leadId,
            leadPhoneE164: params.customerPhone,
            leadSummary: summary,
            source: 'leadbridge',
          },
          { headers: this.buildHeaders(sigcoreApiKey) },
        ),
      );

      const { sessionId, status } = response.data || {};
      if (!sessionId) {
        this.logger.warn('Sigcore call-connect start returned no sessionId');
        return;
      }

      await this.prisma.leadCallConnect.upsert({
        where: { sigcoreSessionId: sessionId },
        create: {
          leadId: params.leadId,
          businessId: sigcoreBusinessId,
          sigcoreSessionId: sessionId,
          status: this.mapStatus(status || 'CREATED'),
          attempt: 0,
          timeline: [],
          lastEventAt: new Date(),
        },
        update: {
          status: this.mapStatus(status || 'CREATED'),
          lastEventAt: new Date(),
        },
      });

      this.logger.log(`Call-connect session started: ${sessionId} for lead ${params.leadId}`);
    } catch (err: any) {
      this.logger.error(
        `Failed to start call-connect for lead ${params.leadId}: ${err.message}`,
      );
    }
  }

  // ─── Webhook event processing ────────────────────────────────────────────────

  /**
   * Verify HMAC-SHA256 signature on incoming call-connect webhook.
   * Looks up the per-business secret from CallConnectSettings via accountId.
   * Falls back to env-level secret if accountId not provided.
   */
  async verifyWebhookSignature(
    signature: string,
    rawBody: string,
    accountId?: string,
  ): Promise<boolean> {
    let secret: string | undefined;

    if (accountId) {
      const settings = await this.prisma.callConnectSettings.findUnique({
        where: { savedAccountId: accountId },
        select: { sigcoreWebhookSecret: true },
      });
      secret = settings?.sigcoreWebhookSecret ?? undefined;
    }

    // Fall back to env-level secret
    if (!secret) {
      secret = this.configService.get<string>('SIGCORE_CALL_CONNECT_WEBHOOK_SECRET');
    }

    if (!secret) return true; // No secret configured — accept all

    try {
      const expected = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  /**
   * Handle an incoming call-connect event webhook from Sigcore.
   */
  async handleWebhookEvent(payload: any): Promise<void> {
    const event = payload.event as string;
    const timestamp = payload.timestamp as string;
    const data = payload.data || {};
    const sessionId = data.sessionId as string;

    if (!sessionId) {
      this.logger.warn('Call-connect webhook missing sessionId');
      return;
    }

    const status = this.mapStatus(data.status || event);
    const attempt = typeof data.attempt === 'number' ? data.attempt : undefined;
    const failureReason = data.reason ?? null;

    // Find existing session to append to timeline
    const existing = await this.prisma.leadCallConnect.findUnique({
      where: { sigcoreSessionId: sessionId },
    });

    if (!existing) {
      // Unknown session — create a stub and continue
      this.logger.warn(`Received webhook for unknown session ${sessionId} — creating stub`);
    }

    const existingTimeline: any[] = Array.isArray((existing as any)?.timeline)
      ? (existing as any).timeline
      : [];
    const newTimelineEntry = { event, timestamp: timestamp || new Date().toISOString(), data };

    await this.prisma.leadCallConnect.upsert({
      where: { sigcoreSessionId: sessionId },
      create: {
        leadId: data.leadId || 'unknown',
        businessId: data.businessId ?? null,
        sigcoreSessionId: sessionId,
        status,
        attempt: attempt ?? 0,
        lastEventAt: new Date(data.updatedAt || Date.now()),
        failureReason,
        recordingUrl: data.recordingUrl ?? null,
        timeline: [newTimelineEntry],
      },
      update: {
        status,
        ...(attempt !== undefined && { attempt }),
        lastEventAt: new Date(data.updatedAt || Date.now()),
        ...(failureReason !== null && { failureReason }),
        ...(data.recordingUrl && { recordingUrl: data.recordingUrl }),
        timeline: [...existingTimeline, newTimelineEntry],
      },
    });

    this.logger.log(`Call-connect session ${sessionId} — event: ${event}, status: ${status}`);
  }

  /** Get all call-connect sessions for a lead */
  async getSessionsForLead(leadId: string) {
    return this.prisma.leadCallConnect.findMany({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Fire a test call to verify call-connect is configured correctly.
   * Uses a caller-supplied test customer phone so the agent can verify the bridge works.
   */
  async triggerTestCall(savedAccountId: string, testPhone: string): Promise<{ sessionId: string | null }> {
    const ns = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
      select: { sigcoreApiKey: true, sigcoreWorkspaceId: true },
    });

    const accountKey = ns?.sigcoreApiKey;
    const envKey = this.configService.get<string>('SIGCORE_API_KEY');
    const sigcoreApiKey = envKey || accountKey || null; // env var is authoritative

    this.logger.log(
      `[triggerTestCall] accountKey=${accountKey ? `"${accountKey.slice(0, 6)}…" (len ${accountKey.length})` : 'empty/null'} | ` +
      `envKey=${envKey ? `"${envKey.slice(0, 6)}…" (len ${envKey.length})` : 'not set'} | ` +
      `using=${sigcoreApiKey ? `"${sigcoreApiKey.slice(0, 6)}…"` : 'NONE'}`
    );

    if (!sigcoreApiKey) {
      throw new BadRequestException('No Sigcore API key configured in Notification Settings');
    }

    const settings = await this.prisma.callConnectSettings.findUnique({
      where: { savedAccountId },
    });
    if (!settings?.enabled) {
      throw new BadRequestException('Instant Call Connect is not enabled for this account');
    }

    const sigcoreBusinessId = ns?.sigcoreWorkspaceId || savedAccountId;

    // Always sync settings to Sigcore before test call so agentAcceptDigits is current
    try {
      await this.pushSettingsToSigcore(savedAccountId, settings);
    } catch (err: any) {
      this.logger.warn(`Failed to push settings before test call: ${err.message}`);
    }

    const url = `${this.sigcoreApiUrl}/api/internal/call-connect/start`;

    const testCustomer = {
      name: 'Test Customer',
      category: 'House Cleaning',
      city: 'Tampa',
      state: 'FL',
    };
    const leadSummary = `${testCustomer.name} — ${testCustomer.category} — ${testCustomer.city}, ${testCustomer.state}`;

    let response: any;
    try {
      response = await firstValueFrom(
        this.httpService.post(
          url,
          {
            businessId: sigcoreBusinessId,
            leadId: `test-${Date.now()}`,
            leadPhoneE164: testPhone,
            leadSummary,
            source: 'leadbridge',
          },
          { headers: this.buildHeaders(sigcoreApiKey) },
        ),
      );
    } catch (err: any) {
      const sigcoreMsg = err.response?.data?.message || err.response?.data?.error || err.message;
      this.logger.error(`Sigcore test call failed: ${sigcoreMsg}`);
      throw new BadRequestException(`Sigcore error: ${sigcoreMsg}`);
    }

    const sessionId = response.data?.sessionId || null;
    this.logger.log(`Test call-connect session started: ${sessionId} (test phone: ${testPhone})`);
    return { sessionId };
  }

  /** Cancel a call-connect session */
  async cancelSession(sessionId: string, savedAccountId: string): Promise<void> {
    const apiKey = await this.getSigcoreApiKey(savedAccountId);
    if (!apiKey) return;

    const url = `${this.sigcoreApiUrl}/api/internal/call-connect/cancel`;
    await firstValueFrom(
      this.httpService.post(
        url,
        { sessionId },
        { headers: this.buildHeaders(apiKey) },
      ),
    );

    await this.prisma.leadCallConnect.update({
      where: { sigcoreSessionId: sessionId },
      data: { status: 'CANCELED', lastEventAt: new Date() },
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private mapStatus(raw: string): any {
    const map: Record<string, string> = {
      // Current spec values
      CREATED: 'CREATED',
      'call_connect.session.created': 'CREATED',
      CALLING_AGENT: 'CALLING_AGENT',
      'call_connect.agent.ringing': 'CALLING_AGENT',
      AGENT_ANSWERED: 'AGENT_ANSWERED',
      AGENT_ACCEPTED: 'AGENT_ACCEPTED',
      'call_connect.agent.accepted': 'AGENT_ACCEPTED',
      CALLING_LEAD: 'CALLING_LEAD',
      'call_connect.lead.ringing': 'CALLING_LEAD',
      BRIDGED: 'BRIDGED',
      'call_connect.bridged': 'BRIDGED',
      VOICEMAIL_DROP: 'VOICEMAIL_DROP',
      'call_connect.voicemail_drop': 'VOICEMAIL_DROP',
      ENDED: 'ENDED',
      'call_connect.ended': 'ENDED',
      FAILED: 'FAILED',
      'call_connect.failed': 'FAILED',
      CANCELED: 'CANCELED',
      CANCELLED: 'CANCELLED', // legacy
    };
    return (map[raw] || 'CREATED') as any;
  }
}
