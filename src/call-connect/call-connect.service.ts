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
    // SIGCORE_CALL_CONNECT_URL lets call-connect point to a different Sigcore instance
    // (e.g. staging) while notifications/SMS continue using SIGCORE_API_URL (production).
    const rawUrl =
      this.configService.get<string>('SIGCORE_CALL_CONNECT_URL') ||
      this.configService.get<string>('SIGCORE_API_URL') ||
      'https://sigcore-production.up.railway.app/api';
    // Strip trailing /api — we build full paths ourselves using /api/internal/...
    this.sigcoreApiUrl = rawUrl.replace(/\/api\/?$/, '');

    const rawBaseUrl =
      this.configService.get<string>('APP_BASE_URL') ||
      this.configService.get<string>('FRONTEND_URL') ||
      'https://www.leadbridge360.com';
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

  /** Push call-connect settings to Sigcore and verify they were saved */
  private async pushSettingsToSigcore(savedAccountId: string, settings: any): Promise<void> {
    const apiKey = await this.getSigcoreApiKey(savedAccountId);
    if (!apiKey) {
      this.logger.warn(`[pushSettings] No Sigcore API key for account ${savedAccountId} — skipping`);
      return;
    }

    const payload = {
      enabled: settings.enabled,
      mode: settings.mode,
      botNumberE164: settings.botNumberE164,
      agentPhoneE164: settings.agentPhoneE164,
      ringTimeoutSeconds: 60,
      maxAgentAttempts: settings.maxAgentAttempts,
      agentAcceptDigits: '0123456789',
      agentWhisperMessage: settings.agentWhisperMessage || 'New lead: {summary}. Press any key to connect.',
      leadGreetingMessage: settings.leadGreetingMessage || 'Please hold while we connect you with a specialist.',
      leadVoicemailEnabled: true,
      leadVoicemailMessage: settings.leadVoicemailMessage ?? null,
      leadVoicemailRecordingUrl: settings.leadVoicemailRecordingUrl ?? null,
      ...(settings.quietHoursEnabled && settings.quietHoursTimezone && settings.quietHoursStart && settings.quietHoursEnd && {
        quietHours: {
          timezone: settings.quietHoursTimezone,
          start: settings.quietHoursStart,
          end: settings.quietHoursEnd,
        },
      }),
    };

    const settingsUrl = `${this.sigcoreApiUrl}/api/internal/call-connect/settings`;
    const headers = this.buildHeaders(apiKey);

    this.logger.log(
      `[pushSettings] POST ${settingsUrl} | agentAcceptDigits=${payload.agentAcceptDigits} | mode=${payload.mode} | bot=${payload.botNumberE164} | agent=${payload.agentPhoneE164}`,
    );

    const pushResp = await firstValueFrom(
      this.httpService.post(settingsUrl, payload, { headers }),
    );

    this.logger.log(
      `[pushSettings] Sigcore responded ${pushResp.status} — agentAcceptDigits in response: ${pushResp.data?.agentAcceptDigits ?? 'N/A'}`,
    );

    // Verify with a GET — catch mismatches early
    try {
      const getResp = await firstValueFrom(
        this.httpService.get(settingsUrl, { headers }),
      );
      const saved = getResp.data;
      if (saved?.agentAcceptDigits !== '0123456789') {
        this.logger.error(
          `[pushSettings] MISMATCH! Pushed agentAcceptDigits='0123456789' but Sigcore has '${saved?.agentAcceptDigits}'. ` +
          `Full settings: ${JSON.stringify({ agentAcceptDigits: saved?.agentAcceptDigits, mode: saved?.mode, enabled: saved?.enabled })}`,
        );
      } else {
        this.logger.log(`[pushSettings] Verified: Sigcore settings match (agentAcceptDigits=${saved.agentAcceptDigits})`);
      }
    } catch (verifyErr: any) {
      this.logger.warn(`[pushSettings] Could not verify settings via GET: ${verifyErr.message}`);
    }
  }

  /** Register per-business webhook subscription with Sigcore — re-activates paused subscriptions */
  private async ensureWebhookSubscription(savedAccountId: string, settingsId: string): Promise<void> {
    const apiKey = await this.getSigcoreApiKey(savedAccountId);
    if (!apiKey) return;

    const settings = await this.prisma.callConnectSettings.findUnique({
      where: { id: settingsId },
      select: { sigcoreWebhookId: true, sigcoreWebhookSecret: true },
    });

    const headers = this.buildHeaders(apiKey);
    const subscriptionsUrl = `${this.sigcoreApiUrl}/api/webhooks/subscriptions`;
    const webhookUrl = `${this.appBaseUrl}/api/webhooks/sigcore/call-connect?accountId=${savedAccountId}`;
    const secret = settings?.sigcoreWebhookSecret || crypto.randomBytes(32).toString('hex');

    const CC_EVENTS = [
      'call_connect.session.created',
      'call_connect.agent.ringing',
      'call_connect.agent.accepted',
      'call_connect.lead.ringing',
      'call_connect.bridged',
      'call_connect.voicemail_drop',
      'call_connect.ended',
      'call_connect.failed',
    ];

    // If we have an existing subscription ID, verify it's still active in Sigcore
    if (settings?.sigcoreWebhookId) {
      try {
        const getResp = await firstValueFrom(
          this.httpService.get(`${subscriptionsUrl}/${settings.sigcoreWebhookId}`, { headers }),
        );
        const sub = getResp.data?.data ?? getResp.data;
        if (sub?.status === 'paused') {
          // Re-activate the paused subscription
          await firstValueFrom(
            this.httpService.patch(
              `${subscriptionsUrl}/${settings.sigcoreWebhookId}`,
              { status: 'active' },
              { headers },
            ),
          );
          this.logger.log(`Re-activated paused Sigcore webhook subscription ${settings.sigcoreWebhookId} for account ${savedAccountId}`);
        } else {
          this.logger.log(`Sigcore webhook subscription ${settings.sigcoreWebhookId} is active — no action needed`);
        }
        return;
      } catch (err: any) {
        if (err.response?.status === 404) {
          // Subscription was deleted on Sigcore side — clear stale ID and re-create below
          this.logger.warn(`Sigcore webhook subscription ${settings.sigcoreWebhookId} not found (404) — re-creating`);
          await this.prisma.callConnectSettings.update({
            where: { id: settingsId },
            data: { sigcoreWebhookId: null },
          });
        } else {
          throw err;
        }
      }
    }

    // Create new subscription
    const response = await firstValueFrom(
      this.httpService.post(
        subscriptionsUrl,
        { name: 'LeadBridge Call Connect', webhookUrl, secret, events: CC_EVENTS },
        { headers },
      ),
    );

    const webhookId = response.data?.data?.id ?? response.data?.id ?? response.data?.webhookId;

    await this.prisma.callConnectSettings.update({
      where: { id: settingsId },
      data: {
        sigcoreWebhookId: webhookId || null,
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

    // Build the complete whisper message on LeadBridge's side so Sigcore receives
    // the final text directly — no template substitution needed on Sigcore's end.
    // If settings has a custom template, apply vars here; otherwise use default.
    const whisperTemplate = settings.agentWhisperMessage || 'New lead: {summary}. Press any key to connect.';
    const agentWhisperMessage = whisperTemplate
      .replace(/\{summary\}/g, summary)
      .replace(/\{customerName\}/g, params.customerName || '')
      .replace(/\{accountName\}/g, params.customerName || '')  // alias for {customerName}
      .replace(/\{category\}/g, params.category || '')
      .replace(/\{location\}/g, params.location || '');

    // Pre-build the voicemail message the same way so Sigcore receives the final text.
    // Sigcore will use this per-session value (overriding the workspace template) so the
    // message already has customerName, phone, etc. substituted correctly.
    const voicemailTemplate = settings.leadVoicemailMessage || '';
    const leadVoicemailMessage = voicemailTemplate
      ? voicemailTemplate
          .replace(/\{summary\}/g, summary)
          .replace(/\{customerName\}/g, params.customerName || '')
          .replace(/\{accountName\}/g, params.customerName || '')  // alias for {customerName}
          .replace(/\{category\}/g, params.category || '')
          .replace(/\{location\}/g, params.location || '')
          .replace(/\{phone\}/g, params.customerPhone || '')
      : undefined;

    try {
      const url = `${this.sigcoreApiUrl}/api/internal/call-connect/start`;

      this.logger.log(
        `[triggerForLead] POST ${url} | businessId=${sigcoreBusinessId} | lead=${params.leadId} | phone=${params.customerPhone} | whisper="${agentWhisperMessage}" | voicemail="${leadVoicemailMessage ?? '(settings default)'}"`,
      );

      const response = await firstValueFrom(
        this.httpService.post(
          url,
          {
            businessId: sigcoreBusinessId,
            leadId: params.leadId,
            leadPhoneE164: params.customerPhone,
            leadSummary: summary,
            agentWhisperMessage,
            ...(leadVoicemailMessage && { leadVoicemailMessage }),
            agentHint: settings.agentPhoneE164 || undefined,
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

      this.logger.log(
        `[triggerForLead] Session started: ${sessionId} (status=${status}) for lead ${params.leadId}`,
      );
    } catch (err: any) {
      const sigcoreMsg = err.response?.data?.message || err.response?.data?.error || err.message;
      this.logger.error(
        `[triggerForLead] Failed for lead ${params.leadId} (${err.response?.status}): ${sigcoreMsg}`,
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
      // Unknown session — fan-out noise from another account's subscription, or a test call.
      // triggerForLead always pre-creates the LeadCallConnect record, so if it's missing
      // this event doesn't belong to us. Skip silently to avoid FK violations.
      this.logger.debug(`Received webhook for unknown session ${sessionId} — skipping (not owned by this account)`);
      return;
    }

    const existingTimeline: any[] = Array.isArray((existing as any)?.timeline)
      ? (existing as any).timeline
      : [];
    const newTimelineEntry = { event, timestamp: timestamp || new Date().toISOString(), data };

    await this.prisma.leadCallConnect.update({
      where: { sigcoreSessionId: sessionId },
      data: {
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

    // Sync settings to Sigcore before test call — fail loudly so the user knows
    try {
      await this.pushSettingsToSigcore(savedAccountId, settings);
    } catch (err: any) {
      this.logger.error(`[triggerTestCall] Settings push FAILED: ${err.message}`);
      throw new BadRequestException(
        `Failed to sync settings to Sigcore before test call: ${err.message}. ` +
        `The call would use stale settings. Please check your Sigcore API key and try again.`,
      );
    }

    const url = `${this.sigcoreApiUrl}/api/internal/call-connect/start`;

    // Load global admin test-customer config (falls back to defaults if not set).
    const adminCfg = await this.prisma.adminConfig.findUnique({ where: { id: 'global' } });
    const saved = (adminCfg?.testData as Record<string, string> | null) ?? {};
    const td = {
      customerName:       'Test Customer',
      firstName:          'Test',
      accountName:        'Test Business',
      category:           'House Cleaning',
      city:               'Tampa',
      state:              'FL',
      location:           'Tampa, FL',
      zip:                '33601',
      message:            'Looking for reliable cleaning services',
      serviceDescription: 'Standard home cleaning',
      addons:             '',
      frequency:          'Weekly',
      bedrooms:           '3',
      bathrooms:          '2',
      price:              '$120',
      pets:               'None',
      estimate:           '$120',
      dates:              'Flexible',
      // backward-compat: old columns override defaults when present
      ...(adminCfg?.testCustomerName ? { customerName: adminCfg.testCustomerName } : {}),
      ...(adminCfg?.testCategory     ? { category:      adminCfg.testCategory }     : {}),
      ...(adminCfg?.testLocation     ? { location:      adminCfg.testLocation }     : {}),
      // new testData JSON overrides everything
      ...saved,
    };
    const leadSummary = `${td.customerName} — ${td.category} — ${td.location}`;

    /** Apply all template variable substitutions to a string */
    const subst = (tpl: string) =>
      tpl
        .replace(/\{summary\}/g,                 leadSummary)
        .replace(/\{customerName\}/g,             td.customerName)
        .replace(/\{firstName\}/g,                td.firstName)
        .replace(/\{accountName\}/g,              td.accountName)
        .replace(/\{category\}/g,                 td.category)
        .replace(/\{city\}/g,                     td.city)
        .replace(/\{state\}/g,                    td.state)
        .replace(/\{location\}/g,                 td.location)
        .replace(/\{phone\}/g,                    testPhone)
        .replace(/\{lead\.name\}/g,               td.customerName)
        .replace(/\{lead\.phone\}/g,              testPhone)
        .replace(/\{lead\.location\}/g,           td.location)
        .replace(/\{lead\.zip\}/g,                td.zip)
        .replace(/\{lead\.message\}/g,            td.message)
        .replace(/\{lead\.serviceDescription\}/g, td.serviceDescription)
        .replace(/\{lead\.addons\}/g,             td.addons)
        .replace(/\{lead\.frequency\}/g,          td.frequency)
        .replace(/\{lead\.bedrooms\}/g,           td.bedrooms)
        .replace(/\{lead\.bathrooms\}/g,          td.bathrooms)
        .replace(/\{lead\.price\}/g,              td.price)
        .replace(/\{lead\.pets\}/g,               td.pets)
        .replace(/\{lead\.estimate\}/g,           td.estimate)
        .replace(/\{lead\.dates\}/g,              td.dates);

    // Pre-build whisper + voicemail messages with all variables substituted.
    const whisperTemplate = settings.agentWhisperMessage || 'New lead: {summary}. Press any key to connect.';
    const agentWhisperMessage = subst(whisperTemplate);

    const voicemailTemplate = settings.leadVoicemailMessage || '';
    const leadVoicemailMessage = voicemailTemplate ? subst(voicemailTemplate) : undefined;

    const startPayload = {
      businessId: sigcoreBusinessId,
      leadId: `test-${Date.now()}`,
      leadPhoneE164: testPhone,
      leadSummary,
      agentWhisperMessage,
      ...(leadVoicemailMessage && { leadVoicemailMessage }),
      agentHint: settings.agentPhoneE164 || undefined,
      source: 'leadbridge',
    };

    this.logger.log(
      `[triggerTestCall] POST ${url} | businessId=${sigcoreBusinessId} | leadPhone=${testPhone} | agentHint=${settings.agentPhoneE164} | voicemail="${leadVoicemailMessage ?? '(settings default)'}"`,
    );

    let response: any;
    try {
      response = await firstValueFrom(
        this.httpService.post(url, startPayload, { headers: this.buildHeaders(sigcoreApiKey) }),
      );
    } catch (err: any) {
      const sigcoreMsg = err.response?.data?.message || err.response?.data?.error || err.message;
      this.logger.error(`[triggerTestCall] Sigcore /start FAILED (${err.response?.status}): ${sigcoreMsg}`);
      throw new BadRequestException(`Sigcore error: ${sigcoreMsg}`);
    }

    const sessionId = response.data?.sessionId || null;
    const sessionStatus = response.data?.status || 'unknown';
    this.logger.log(
      `[triggerTestCall] Session started: ${sessionId} (status=${sessionStatus}, testPhone=${testPhone})`,
    );
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
      // Current spec values (dot-separated)
      CREATED: 'CREATED',
      'call_connect.session.created': 'CREATED',
      'call_connect.session_created': 'CREATED',
      CALLING_AGENT: 'CALLING_AGENT',
      'call_connect.agent.ringing': 'CALLING_AGENT',
      'call_connect.agent_ringing': 'CALLING_AGENT',
      AGENT_ANSWERED: 'AGENT_ANSWERED',
      AGENT_ACCEPTED: 'AGENT_ACCEPTED',
      'call_connect.agent.accepted': 'AGENT_ACCEPTED',
      'call_connect.agent_accepted': 'AGENT_ACCEPTED',
      CALLING_LEAD: 'CALLING_LEAD',
      'call_connect.lead.ringing': 'CALLING_LEAD',
      'call_connect.lead_ringing': 'CALLING_LEAD',
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
