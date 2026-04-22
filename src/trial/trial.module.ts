import { Global, Module } from '@nestjs/common';
import { TrialService } from './trial.service';

@Global()
@Module({
  providers: [TrialService],
  exports: [TrialService],
})
export class TrialModule {}
