/**
 * Whole features the operator can turn on or off (`MELETE_FEATURE_<NAME>`),
 * as the setup status reports them for whoever is signed in. A feature the
 * status does not name, or one not read yet, counts as on: that is every
 * feature's default but multiplayer, which has its own capability.
 *
 * Hiding a surface is for the person's sake; the service refuses the
 * feature's routes either way.
 */
import type { Capabilities } from './types.ts';

export type FeatureName = 'voice' | 'phone' | 'sms' | 'browser' | 'computer' | 'companies';

export const featureOn = (capabilities: Pick<Capabilities, 'features'>, name: FeatureName) =>
  capabilities.features[name] !== false;
