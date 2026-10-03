/**
 * The adapters an installation offers for command-line accounts. Each one is
 * added here as it is written; until then a connection naming it selects
 * nothing and its hosts stay blind tunnels.
 */
import { githubAdapter } from './github.ts';
import { testAdapter } from './test.ts';
import type { CredentialAdapter, CredentialAdapterId } from './types.ts';

export type AdapterSet = ReadonlyMap<CredentialAdapterId, CredentialAdapter>;

export function credentialAdapters(options: { test?: boolean } = {}): AdapterSet {
  const adapters = new Map<CredentialAdapterId, CredentialAdapter>();
  adapters.set('github', githubAdapter as CredentialAdapter);
  if (options.test) adapters.set('test', testAdapter as CredentialAdapter);
  return adapters;
}
