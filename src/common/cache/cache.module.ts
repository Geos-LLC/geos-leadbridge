import { Global, Module } from '@nestjs/common';
import { CacheService } from './cache.service';
import { LeadCacheService } from './lead-cache.service';

@Global()
@Module({
  providers: [CacheService, LeadCacheService],
  exports: [CacheService, LeadCacheService],
})
export class CacheModule {}
