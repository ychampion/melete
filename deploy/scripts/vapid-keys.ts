/**
 * Prints a fresh Web Push (VAPID) key pair for deploy/.env, for an install
 * configured before push existed. configure.ts writes one on a new install.
 */
import { generateVapidKeys } from '../../apps/melete/src/push/webpush.ts';

const keys = await generateVapidKeys();
process.stdout.write(
  `MELETE_VAPID_PUBLIC_KEY=${keys.publicKey}\nMELETE_VAPID_PRIVATE_KEY=${keys.privateKey}\n`,
);
