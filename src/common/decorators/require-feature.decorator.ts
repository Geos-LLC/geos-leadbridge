import { SetMetadata } from '@nestjs/common';
import { Feature } from '../guards/feature-gate.guard';

export const RequireFeature = (feature: Feature) => SetMetadata('feature', feature);
