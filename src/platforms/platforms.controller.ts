/**
 * Platforms Controller
 * Handles platform connection status and configuration
 */

import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PlatformService } from './platform.service';
import { PrismaService } from '../common/utils/prisma.service';

@Controller('v1/platforms')
@UseGuards(JwtAuthGuard)
export class PlatformsController {
  constructor(
    private platformService: PlatformService,
    private prisma: PrismaService,
  ) {}

  /**
   * Get connection status for all platforms
   */
  @Get('status')
  async getStatus(@CurrentUser() user: any) {
    const platforms = await this.platformService.getUserPlatforms(user.userId);
    const supportedPlatforms = this.platformService.getSupportedPlatforms();

    // Build status for all supported platforms
    const platformStatus = supportedPlatforms.map((name) => {
      const connected = platforms.find((p) => p.platformName === name);
      return {
        platformName: name,
        connected: connected?.connected ?? false,
        lastSyncAt: connected?.lastSyncAt ?? null,
      };
    });

    return { platforms: platformStatus };
  }

  /**
   * Get detailed connection info including configured business
   */
  @Get('connection')
  async getConnectionDetails(@CurrentUser() user: any) {
    const platform = await this.prisma.platform.findUnique({
      where: {
        userId_platformName: {
          userId: user.userId,
          platformName: 'thumbtack',
        },
      },
      select: {
        platformName: true,
        connected: true,
        externalBusinessId: true,
        webhookId: true,
        lastSyncAt: true,
      },
    });

    return {
      thumbtack: platform
        ? {
            connected: platform.connected,
            configuredBusinessId: platform.externalBusinessId,
            webhookId: platform.webhookId,
            lastSyncAt: platform.lastSyncAt,
          }
        : {
            connected: false,
            configuredBusinessId: null,
            webhookId: null,
            lastSyncAt: null,
          },
    };
  }
}
