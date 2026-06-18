import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import {
  AssociatePhonesSignal,
  ConnectionHealth,
  OAuthTokenSignal,
  WebhookSignal,
  deriveOverall,
} from './connection-health.types';

type SignalKey = keyof ConnectionHealth['signals'];

/**
 * Persists per-SavedAccount connection health into the existing
 * `followUpSettingsJson` blob. No schema migration. All callers should
 * `await` the write because read-modify-write means we don't want races
 * between rapid same-account updates within a single request.
 */
@Injectable()
export class ConnectionHealthService {
  private readonly logger = new Logger(ConnectionHealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getHealth(savedAccountId: string): Promise<ConnectionHealth | null> {
    const acc = await this.prisma.savedAccount.findUnique({
      where: { id: savedAccountId },
      select: { followUpSettingsJson: true },
    });
    if (!acc) return null;
    return this.parseHealth(acc.followUpSettingsJson);
  }

  async updateOAuthToken(
    savedAccountId: string,
    patch: Partial<OAuthTokenSignal>,
  ): Promise<void> {
    return this.merge(savedAccountId, 'oauthToken', patch);
  }

  async updateWebhook(
    savedAccountId: string,
    patch: Partial<WebhookSignal>,
  ): Promise<void> {
    return this.merge(savedAccountId, 'webhook', patch);
  }

  async updateAssociatePhones(
    savedAccountId: string,
    patch: Partial<AssociatePhonesSignal>,
  ): Promise<void> {
    return this.merge(savedAccountId, 'associatePhones', patch);
  }

  private async merge(
    savedAccountId: string,
    signal: SignalKey,
    patch: Record<string, unknown>,
  ): Promise<void> {
    try {
      const acc = await this.prisma.savedAccount.findUnique({
        where: { id: savedAccountId },
        select: { followUpSettingsJson: true },
      });
      if (!acc) {
        this.logger.warn(
          `[connection-health] savedAccount ${savedAccountId} not found — skipping ${signal} update`,
        );
        return;
      }

      const settings = this.parseSettings(acc.followUpSettingsJson);
      const health: ConnectionHealth = settings.connectionHealth ?? {
        lastCheckedAt: new Date().toISOString(),
        signals: {},
      };
      const existing = health.signals[signal] ?? {};
      health.signals = {
        ...health.signals,
        [signal]: { ...existing, ...patch },
      } as ConnectionHealth['signals'];
      health.lastCheckedAt = new Date().toISOString();
      settings.connectionHealth = health;

      await this.prisma.savedAccount.update({
        where: { id: savedAccountId },
        data: { followUpSettingsJson: JSON.stringify(settings) },
      });
    } catch (err: any) {
      // Health-blob writes must never block their caller's primary work.
      this.logger.warn(
        `[connection-health] failed to update ${signal} for savedAccount ${savedAccountId}: ${err?.message ?? err}`,
      );
    }
  }

  private parseSettings(raw: string | null): Record<string, any> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private parseHealth(raw: string | null): ConnectionHealth | null {
    const settings = this.parseSettings(raw);
    return (settings.connectionHealth as ConnectionHealth | undefined) ?? null;
  }
}

export { deriveOverall };
