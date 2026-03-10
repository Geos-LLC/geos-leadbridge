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
    let settings = await this.prisma.callConnectSettings.upsert({
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

    // Auto-provision Sigcore workspace if not already done — required for CC to work.
    // Also self-heals shared tenants: if this account shares a workspace with another,
    // ensureSigcoreProvisioned will re-provision a dedicated tenant and return true.
    let reProvisioned = false;
    try {
      reProvisioned = await this.ensureSigcoreProvisioned(savedAccountId);
    } catch (err: any) {
      this.logger.warn(`[saveSettings] Auto-provision Sigcore workspace failed: ${err.message}`);
    }

    // Auto-resolve botNumberE164 from the tenant's dedicated phone if not already set
    if (!settings.botNumberE164) {
      const acctUser = await this.prisma.savedAccount.findUnique({
        where: { id: savedAccountId },
        select: { userId: true },
      });
      if (acctUser) {
        const tenantPhone = await this.prisma.tenantPhoneNumber.findFirst({
          where: { userId: acctUser.userId, savedAccountId: savedAccountId, status: 'ACTIVE' },
          orderBy: { purchasedAt: 'desc' },
          select: { phoneNumber: true },
        });
        if (tenantPhone?.phoneNumber) {
          await this.prisma.callConnectSettings.update({
            where: { id: settings.id },
            data: { botNumberE164: tenantPhone.phoneNumber },
          });
          settings = { ...settings, botNumberE164: tenantPhone.phoneNumber };
          this.logger.log(`[saveSettings] Auto-resolved botNumberE164=${tenantPhone.phoneNumber} for account ${savedAccountId}`);
        }
      }
    }

    // Push settings to Sigcore (best effort).
    // Always push — if re-provisioned, the new workspace needs settings from scratch.
    try {
      await this.pushSettingsToSigcore(savedAccountId, settings);
      if (reProvisioned) {
        this.logger.log(`[saveSettings] Re-pushed CC settings after shared-tenant re-provision for ${savedAccountId}`);
      }
    } catch (err: any) {
      this.logger.warn(`Failed to push call-connect settings to Sigcore: ${err.message}`);
    }

    // Sync agentPhoneE164 → destinationPhone + User.businessPhone
    if (dto.agentPhoneE164 !== undefined) {
      await this.prisma.notificationSettings.updateMany({
        where: { savedAccountId },
        data: { destinationPhone: dto.agentPhoneE164 || null },
      });
      if (dto.agentPhoneE164) {
        await this.prisma.user.update({
          where: { id: userId },
          data: { businessPhone: dto.agentPhoneE164 },
        });
        this.logger.log(`[saveSettings] Synced agentPhone ${dto.agentPhoneE164} → User.businessPhone for user ${userId}`);
      }
    }

    // Sync destinationPhone as call forwarding to Sigcore tenant metadata
    try {
      await this.syncCallForwardingAfterProvision(savedAccountId);
    } catch (err: any) {
      this.logger.warn(`[saveSettings] Failed to sync call forwarding after provision: ${err.message}`);
    }

    // Ensure webhook subscription exists — always attempt so stale/missing IDs get fixed
    try {
      await this.ensureWebhookSubscription(savedAccountId, settings.id);
    } catch (err: any) {
      this.logger.warn(`Failed to register Sigcore call-connect webhook: ${err.message}`);
    }

    // Ensure inbound SMS webhook subscription exists (needed for SMS forwarding)
    try {
      await this.ensureInboundSmsWebhook(savedAccountId);
    } catch (err: any) {
      this.logger.warn(`[saveSettings] Failed to ensure inbound SMS webhook: ${err.message}`);
    }

    return settings;
  }

  // ─── Sigcore API ─────────────────────────────────────────────────────────────

  /**
   * Ensure a Sigcore tenant/workspace exists for this account.
   * Required for CC to resolve a valid businessId that Sigcore recognizes.
   * Idempotent — skips if already provisioned with a DEDICATED (non-shared) tenant.
   * Returns true if re-provisioning occurred (caller should re-push settings).
   */
  private async ensureSigcoreProvisioned(savedAccountId: string): Promise<boolean> {
    const ns = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
      select: { sigcoreTenantId: true, sigcoreWorkspaceId: true },
    });

    const oldTenantId = ns?.sigcoreTenantId || null;

    // Already provisioned — check for shared tenants (from old auto-copy logic)
    if (ns?.sigcoreTenantId) {
      // Back-fill sigcoreWorkspaceId if missing
      if (!ns.sigcoreWorkspaceId) {
        await this.prisma.notificationSettings.update({
          where: { savedAccountId },
          data: { sigcoreWorkspaceId: ns.sigcoreTenantId },
        });
        this.logger.log(`[ensureSigcoreProvisioned] Back-filled sigcoreWorkspaceId=${ns.sigcoreTenantId} for ${savedAccountId}`);
      }

      // Check if this tenant is shared — each account MUST have its own workspace
      // to avoid cross-account CC setting contamination.
      const sharedCount = await this.prisma.notificationSettings.count({
        where: {
          sigcoreTenantId: ns.sigcoreTenantId,
          NOT: { savedAccountId },
        },
      });

      if (sharedCount === 0) {
        return false; // Dedicated tenant — all good
      }

      this.logger.warn(
        `[ensureSigcoreProvisioned] Account ${savedAccountId} shares tenantId ${ns.sigcoreTenantId} ` +
        `with ${sharedCount} other account(s) — re-provisioning with dedicated tenant`,
      );
    }

    // Need to provision — requires platform-level API key
    const platformKey = this.configService.get<string>('SIGCORE_API_KEY');
    if (!platformKey) {
      this.logger.warn(`[ensureSigcoreProvisioned] No SIGCORE_API_KEY — cannot auto-provision for ${savedAccountId}`);
      return false;
    }

    const sigcoreUrl =
      this.configService.get<string>('SIGCORE_API_URL') ||
      'https://sigcore-production.up.railway.app/api';

    const resp = await firstValueFrom(
      this.httpService.post(
        `${sigcoreUrl}/tenants/provision`,
        { externalTenantId: savedAccountId, displayName: `Account ${savedAccountId}` },
        { headers: { 'Content-Type': 'application/json', 'x-api-key': platformKey }, timeout: 15_000 },
      ),
    );

    const data = resp.data?.data ?? resp.data;
    const tenantId = data?.tenantId;
    const tenantApiKey = data?.apiKey;

    if (!tenantId) {
      this.logger.warn(`[ensureSigcoreProvisioned] Provision response missing tenantId for ${savedAccountId}`);
      return false;
    }

    // Upsert notification settings with workspace + tenant IDs
    await this.prisma.notificationSettings.upsert({
      where: { savedAccountId },
      update: {
        sigcoreTenantId: tenantId,
        sigcoreWorkspaceId: tenantId,
        ...(tenantApiKey && { sigcoreApiKey: tenantApiKey }),
        sigcoreProvisionedAt: new Date(),
      },
      create: {
        savedAccountId,
        sigcoreTenantId: tenantId,
        sigcoreWorkspaceId: tenantId,
        ...(tenantApiKey && { sigcoreApiKey: tenantApiKey }),
        sigcoreProvisionedAt: new Date(),
        enabled: false,
      },
    });

    this.logger.log(`[ensureSigcoreProvisioned] Auto-provisioned tenant ${tenantId} for account ${savedAccountId}`);

    // Copy integrations from old tenant to new tenant (OpenPhone, etc.)
    if (oldTenantId && oldTenantId !== tenantId) {
      try {
        await firstValueFrom(
          this.httpService.post(
            `${sigcoreUrl}/tenants/${tenantId}/copy-integrations`,
            { fromTenantId: oldTenantId },
            { headers: { 'Content-Type': 'application/json', 'x-api-key': platformKey }, timeout: 15_000 },
          ),
        );
        this.logger.log(`[ensureSigcoreProvisioned] Copied integrations from tenant ${oldTenantId} → ${tenantId}`);
      } catch (err: any) {
        this.logger.warn(`[ensureSigcoreProvisioned] Could not copy integrations: ${err.message}`);
      }

      // Refresh Twilio webhook URLs for all phone numbers on the NEW tenant so inbound calls/SMS
      // route to the correct workspace. Must use tenantId (new), not oldTenantId — phone numbers
      // are already in tenant_phone_numbers under the new tenant after re-provisioning.
      // Must use this.sigcoreApiUrl (SIGCORE_CALL_CONNECT_URL || SIGCORE_API_URL)
      // because the phone numbers are registered on whichever Sigcore instance handles CC calls.
      try {
        await firstValueFrom(
          this.httpService.post(
            `${this.sigcoreApiUrl}/api/tenants/${tenantId}/phone-numbers/refresh-webhooks`,
            {},
            { headers: { 'Content-Type': 'application/json', 'x-api-key': platformKey }, timeout: 15_000 },
          ),
        );
        this.logger.log(`[ensureSigcoreProvisioned] Refreshed phone webhooks for new tenant ${tenantId}`);
      } catch (err: any) {
        this.logger.warn(`[ensureSigcoreProvisioned] Could not refresh phone webhooks: ${err.message}`);
      }
    }

    return true; // Re-provisioned — caller should re-push settings
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
    };
  }

  /** Get Sigcore API key — account tenant key only; env key is never used for tenant CC flows */
  private async getSigcoreApiKey(savedAccountId: string): Promise<string | null> {
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

    // Prefix messages with a brief TTS pause ("... ,") so Twilio doesn't clip
    // the first ~1 second of audio when the call leg connects.
    const pausePrefix = '... , ';
    const whisperRaw = settings.agentWhisperMessage || 'You have a new lead for {category}. Customer name: {customerName}. Press any key to connect with the customer.';
    const greetingRaw = settings.leadGreetingMessage || 'Please hold while we connect you with a specialist.';
    const vmRaw = settings.leadVoicemailMessage ?? null;

    const payload = {
      enabled: settings.enabled,
      mode: settings.mode,
      botNumberE164: settings.botNumberE164,
      agentPhoneE164: settings.agentPhoneE164,
      ringTimeoutSeconds: 60,
      maxAgentAttempts: settings.maxAgentAttempts,
      agentAcceptDigits: (!settings.agentAcceptDigits || settings.agentAcceptDigits === '1') ? '0123456789*#' : settings.agentAcceptDigits,
      agentWhisperMessage: pausePrefix + whisperRaw,
      leadGreetingMessage: pausePrefix + greetingRaw,
      leadVoicemailEnabled: true,
      leadVoicemailMessage: vmRaw ? pausePrefix + vmRaw : null,
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
      this.httpService.post(settingsUrl, payload, { headers, timeout: 15_000 }),
    );

    this.logger.log(
      `[pushSettings] Sigcore responded ${pushResp.status} — agentAcceptDigits in response: ${pushResp.data?.agentAcceptDigits ?? 'N/A'}`,
    );

    // Verify with a GET — catch mismatches early
    try {
      const getResp = await firstValueFrom(
        this.httpService.get(settingsUrl, { headers, timeout: 15_000 }),
      );
      const saved = getResp.data;
      if (saved?.agentAcceptDigits !== payload.agentAcceptDigits) {
        this.logger.error(
          `[pushSettings] MISMATCH! Pushed agentAcceptDigits='${payload.agentAcceptDigits}' but Sigcore has '${saved?.agentAcceptDigits}'. ` +
          `Full settings: ${JSON.stringify({ agentAcceptDigits: saved?.agentAcceptDigits, mode: saved?.mode, enabled: saved?.enabled })}`,
        );
      } else {
        this.logger.log(`[pushSettings] Verified: Sigcore settings match (agentAcceptDigits=${saved.agentAcceptDigits})`);
      }
    } catch (verifyErr: any) {
      this.logger.warn(`[pushSettings] Could not verify settings via GET: ${verifyErr.message}`);
    }
  }

  /**
   * Push destinationPhone as callForwardingNumber to Sigcore tenant metadata.
   * All call forwarding goes to the agent's phone (destinationPhone).
   * Called after ensureSigcoreProvisioned so sigcoreTenantId is always fresh/correct.
   */
  private async syncCallForwardingAfterProvision(savedAccountId: string): Promise<void> {
    const ns = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
      select: { sigcoreTenantId: true, destinationPhone: true },
    });

    if (!ns?.sigcoreTenantId) {
      this.logger.warn(`[syncCallForwarding] No sigcoreTenantId for account ${savedAccountId} — skipping`);
      return;
    }

    const platformKey = this.configService.get<string>('SIGCORE_API_KEY');
    if (!platformKey) return;

    const forwardingNumber = ns.destinationPhone || null;

    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 15_000);
    const resp = await fetch(`${this.sigcoreApiUrl}/api/tenants/${ns.sigcoreTenantId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-api-key': platformKey },
      body: JSON.stringify({ metadata: { callForwardingNumber: forwardingNumber } }),
      signal: controller.signal,
    });
    clearTimeout(fetchTimeout);

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Sigcore tenant update failed (${resp.status}): ${text}`);
    }

    this.logger.log(
      `[syncCallForwarding] Synced callForwardingNumber=${forwardingNumber || 'none'} (from destinationPhone) to tenant ${ns.sigcoreTenantId} for account ${savedAccountId}`,
    );
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
          this.httpService.get(`${subscriptionsUrl}/${settings.sigcoreWebhookId}`, { headers, timeout: 15_000 }),
        );
        const sub = getResp.data?.data ?? getResp.data;
        if (sub?.status === 'paused') {
          // Re-activate the paused subscription
          await firstValueFrom(
            this.httpService.patch(
              `${subscriptionsUrl}/${settings.sigcoreWebhookId}`,
              { status: 'active' },
              { headers, timeout: 15_000 },
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
        { headers, timeout: 15_000 },
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

  /** Ensure inbound SMS webhook subscription exists for this account */
  private async ensureInboundSmsWebhook(savedAccountId: string): Promise<void> {
    const ns = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
      select: { id: true, sigcoreApiKey: true, inboundSmsWebhookId: true },
    });
    if (!ns?.sigcoreApiKey || ns.inboundSmsWebhookId) return; // already registered or no key

    const appBaseUrl = this.configService.get<string>('APP_BASE_URL', 'https://www.leadbridge360.com');
    const webhookUrl = `${appBaseUrl}/api/webhooks/sigcore/inbound-sms?accountId=${savedAccountId}`;
    const sigcoreUrl = this.configService.get<string>('SIGCORE_API_URL', 'https://sigcore-production.up.railway.app/api');

    const resp = await fetch(`${sigcoreUrl}/v1/webhook-subscriptions`, {
      method: 'POST',
      headers: { 'x-api-key': ns.sigcoreApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'LeadBridge Inbound SMS',
        webhookUrl,
        events: ['sms.message.received', 'message.inbound'],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const text = await resp.text();
      this.logger.warn(`[ensureInboundSmsWebhook] Failed (${resp.status}): ${text}`);
      return;
    }

    const result = await resp.json();
    const webhookId = result.data?.id || result.id || result.subscriptionId;

    if (webhookId) {
      await this.prisma.notificationSettings.update({
        where: { id: ns.id },
        data: { inboundSmsWebhookId: webhookId },
      });
      this.logger.log(`[ensureInboundSmsWebhook] Registered inbound SMS webhook: ${webhookId} for account ${savedAccountId}`);
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
    accountName?: string | null;
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

    // Self-heal shared tenants before anything else — ensures this account has
    // its own dedicated Sigcore workspace so CC settings don't leak across accounts.
    try {
      const reProvisioned = await this.ensureSigcoreProvisioned(params.savedAccountId);
      if (reProvisioned) {
        // Re-push CC settings to the new dedicated workspace
        const freshSettings = await this.prisma.callConnectSettings.findUnique({
          where: { savedAccountId: params.savedAccountId },
        });
        if (freshSettings) {
          await this.pushSettingsToSigcore(params.savedAccountId, freshSettings);
          this.logger.log(`[triggerForLead] Re-pushed CC settings after shared-tenant re-provision for ${params.savedAccountId}`);
        }
      }
    } catch (err: any) {
      this.logger.warn(`[triggerForLead] Shared-tenant self-heal failed: ${err.message}`);
    }

    // Get API key from NotificationSettings — prefer account's own tenant key
    // so each account's Call Connect operates in its own isolated Sigcore workspace.
    const ns = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId: params.savedAccountId },
      select: { sigcoreApiKey: true, sigcoreWorkspaceId: true, sigcoreTenantId: true },
    });
    const sigcoreApiKey = ns?.sigcoreApiKey || null;
    if (!sigcoreApiKey) {
      this.logger.log(`[triggerForLead] Skipping call-connect for ${params.savedAccountId} — no tenant Sigcore API key configured`);
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

    // Guard: prevent calling when bot number matches the customer phone
    const normBot = (settings.botNumberE164 || '').replace(/\D/g, '').slice(-10);
    const normCustomer = (params.customerPhone || '').replace(/\D/g, '').slice(-10);
    if (normBot.length >= 10 && normBot === normCustomer) {
      this.logger.warn(
        `[triggerForLead] BLOCKED: botNumber=${settings.botNumberE164} matches customerPhone=${params.customerPhone} — skipping`,
      );
      return;
    }

    // Resolve workspace/business ID from NotificationSettings
    const sigcoreBusinessId = ns?.sigcoreWorkspaceId || ns?.sigcoreTenantId || params.businessId || params.savedAccountId;

    const summary =
      params.leadSummary ||
      [params.customerName, params.category].filter(Boolean).join(' – ');

    // Build the complete whisper message on LeadBridge's side so Sigcore receives
    // the final text directly — no template substitution needed on Sigcore's end.
    // If settings has a custom template, apply vars here; otherwise use default.
    const whisperTemplate = settings.agentWhisperMessage || 'You have a new lead for {category}. Customer name: {customerName}. Press any key to connect with the customer.';

    /** Apply all template variable substitutions to a string */
    const subst = (tpl: string) =>
      tpl
        .replace(/\{summary\}/g, summary)
        .replace(/\{customerName\}/g, params.customerName || '')
        .replace(/\{accountName\}/g, params.accountName || '')
        .replace(/\{firstName\}/g, (params.customerName || '').split(' ')[0])
        .replace(/\{category\}/g, params.category || '')
        .replace(/\{location\}/g, params.location || '')
        .replace(/\{phone\}/g, params.customerPhone || '')
        .replace(/\{lead\.name\}/g, params.customerName || '')
        .replace(/\{lead\.phone\}/g, params.customerPhone || '')
        .replace(/\{lead\.location\}/g, params.location || '')
        .replace(/\{lead\.message\}/g, '')
        .replace(/\{lead\.serviceDescription\}/g, params.category || '');

    // Prefix with a brief TTS pause so Twilio doesn't clip the first ~1s of audio
    const pausePrefix = '... , ';
    const agentWhisperMessage = pausePrefix + subst(whisperTemplate);

    // Pre-build the voicemail message the same way so Sigcore receives the final text.
    // Sigcore will use this per-session value (overriding the workspace template) so the
    // message already has customerName, phone, etc. substituted correctly.
    const DEFAULT_VOICEMAIL = 'Hi {customerName}, this is {accountName}. We tried to reach you about your {category} request. Please call us back and we\'ll be happy to help!';
    const voicemailTemplate = settings.leadVoicemailMessage || DEFAULT_VOICEMAIL;
    const leadVoicemailMessage = pausePrefix + subst(voicemailTemplate);

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
            leadVoicemailMessage,
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
    const [ns, savedAccount] = await Promise.all([
      this.prisma.notificationSettings.findUnique({
        where: { savedAccountId },
        select: { sigcoreApiKey: true, sigcoreWorkspaceId: true, sigcoreTenantId: true },
      }),
      this.prisma.savedAccount.findUnique({
        where: { id: savedAccountId },
        select: { userId: true, businessName: true },
      }),
    ]);

    if (!savedAccount) {
      throw new BadRequestException('Saved account not found');
    }

    const sigcoreApiKey = ns?.sigcoreApiKey || null;

    this.logger.log(
      `[triggerTestCall] using=${sigcoreApiKey ? `"${sigcoreApiKey.slice(0, 6)}…" (len ${sigcoreApiKey.length})` : 'NONE'}`
    );

    if (!sigcoreApiKey) {
      throw new BadRequestException('No tenant Sigcore API key configured. Connect your Sigcore account in Notification Settings.');
    }

    const settings = await this.prisma.callConnectSettings.findUnique({
      where: { savedAccountId },
    });
    if (!settings?.enabled) {
      throw new BadRequestException('Instant Call Connect is not enabled for this account');
    }

    // Guard: prevent test call when bot or agent number matches the test phone
    const normTest = testPhone.replace(/\D/g, '').slice(-10);
    const normBotTest = (settings.botNumberE164 || '').replace(/\D/g, '').slice(-10);
    const normAgentTest = (settings.agentPhoneE164 || '').replace(/\D/g, '').slice(-10);
    if (normTest.length >= 10 && normTest === normBotTest) {
      throw new BadRequestException('Test phone cannot be the same as the bot number');
    }
    if (normTest.length >= 10 && normTest === normAgentTest) {
      throw new BadRequestException('Test phone cannot be the same as the agent phone');
    }

    const sigcoreBusinessId = ns?.sigcoreWorkspaceId || ns?.sigcoreTenantId || savedAccountId;

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
    const whisperTemplate = settings.agentWhisperMessage || 'You have a new lead for {category}. Customer name: {customerName}. Press any key to connect with the customer.';
    const agentWhisperMessage = subst(whisperTemplate);

    const DEFAULT_VOICEMAIL = 'Hi {customerName}, this is {accountName}. We tried to reach you about your {category} request. Please call us back and we\'ll be happy to help!';
    const voicemailTemplate = settings.leadVoicemailMessage || DEFAULT_VOICEMAIL;
    const leadVoicemailMessage = subst(voicemailTemplate);

    const startPayload = {
      businessId: sigcoreBusinessId,
      leadId: `test-${Date.now()}`,
      leadPhoneE164: testPhone,
      leadSummary,
      agentWhisperMessage,
      leadVoicemailMessage,
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

    // Create (or reuse) a persistent test lead for this tenant so the LeadCallConnect FK is satisfied.
    if (sessionId) {
      const testExternalId = `cc-test-${savedAccountId}`;
      const testLead = await this.prisma.lead.upsert({
        where: { platform_externalRequestId: { platform: 'test', externalRequestId: testExternalId } },
        create: {
          userId: savedAccount.userId,
          platform: 'test',
          businessId: savedAccountId,
          externalRequestId: testExternalId,
          customerName: td.customerName,
          customerPhone: testPhone,
          message: 'Call Connect test call',
          category: td.category,
          city: td.city,
          state: td.state,
          rawJson: '{}',
          status: 'new',
        },
        update: {
          customerPhone: testPhone,
          updatedAt: new Date(),
        },
      });

      await this.prisma.leadCallConnect.upsert({
        where: { sigcoreSessionId: sessionId },
        create: {
          leadId: testLead.id,
          businessId: sigcoreBusinessId,
          sigcoreSessionId: sessionId,
          status: this.mapStatus(sessionStatus || 'CREATED'),
          attempt: 0,
          timeline: [],
          lastEventAt: new Date(),
        },
        update: {
          status: this.mapStatus(sessionStatus || 'CREATED'),
          lastEventAt: new Date(),
        },
      });
    }

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
