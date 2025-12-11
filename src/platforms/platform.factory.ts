/**
 * Platform Factory
 * Returns the correct platform adapter based on platform name
 */

import { Injectable, BadRequestException } from '@nestjs/common';
import { IPlatformAdapter, PlatformName } from '../common/interfaces/platform.interface';
import { ThumbtackAdapter } from './thumbtack/thumbtack.adapter';

@Injectable()
export class PlatformFactory {
  constructor(private thumbtackAdapter: ThumbtackAdapter) {}

  /**
   * Get the appropriate platform adapter
   */
  getAdapter(platformName: string): IPlatformAdapter {
    switch (platformName.toLowerCase()) {
      case PlatformName.THUMBTACK:
        return this.thumbtackAdapter;

      // Add more platforms here as they're implemented
      // case PlatformName.YELP:
      //   return this.yelpAdapter;

      default:
        throw new BadRequestException(`Unsupported platform: ${platformName}`);
    }
  }

  /**
   * Get all supported platform names
   */
  getSupportedPlatforms(): string[] {
    return [PlatformName.THUMBTACK];
  }
}
