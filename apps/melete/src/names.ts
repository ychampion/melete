/**
 * The names the installation goes by, for words a person reads that the
 * service writes: texts, calls, pushes, approval cards and replies.
 * `assistantName()` is what the assistant calls itself (`MELETE_ASSISTANT_NAME`),
 * `instanceName()` what the installation calls itself (`MELETE_INSTANCE_NAME`).
 * Both are "Melete" when unset, so an installation that sets neither reads as
 * before, and the assistant takes the installation's name when only that is set.
 *
 * They are read from the environment the service started with, the same one
 * its settings were checked against, so a module may build its sentences once.
 */
import { assistantDisplayName, displayName } from '@melete/contracts';

export const assistantName = (): string =>
  assistantDisplayName(process.env.MELETE_ASSISTANT_NAME, process.env.MELETE_INSTANCE_NAME);

export const instanceName = (): string =>
  displayName(process.env.MELETE_INSTANCE_NAME, 'MELETE_INSTANCE_NAME');
