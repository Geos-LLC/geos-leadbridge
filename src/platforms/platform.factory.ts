/**
 * Platform Factory
 * Returns the correct platform adapter based on platform name
 */

import { Injectable, BadRequestException } from '@nestjs/common';
import { IPlatformAdapter, PlatformName } from '../common/interfaces/platform.interface';
import { ThumbtackAdapter } from './thumbtack/thumbtack.adapter';
import { YelpAdapter } from './yelp/yelp.adapter';

@Injectable()
export class PlatformFactory {
  constructor(
    private thumbtackAdapter: ThumbtackAdapter,
    private yelpAdapter: YelpAdapter,
  ) {}

  /**
   * Get the appropriate platform adapter
   */
  getAdapter(platformName: string): IPlatformAdapter {
    switch (platformName.toLowerCase()) {
      case PlatformName.THUMBTACK:
        return this.thumbtackAdapter;
      case PlatformName.YELP:
        return this.yelpAdapter;
      default:
        throw new BadRequestException(`Unsupported platform: ${platformName}`);
    }
  }

  /**
   * Get all supported platform names
   */
  getSupportedPlatforms(): string[] {
    return [PlatformName.THUMBTACK, PlatformName.YELP];
  }
}
