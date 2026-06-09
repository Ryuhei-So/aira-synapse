import type { FeatureGates } from '../../application/runtime/DegradedModePolicy.js';

export type FeatureGateName = keyof FeatureGates;

export function assertFeatureAvailable(gates: FeatureGates, feature: FeatureGateName): void {
  if (!gates[feature]) {
    throw new Error(`FEATURE_REQUIRES_API: feature ${feature} is not available in the current runtime mode`);
  }
}
