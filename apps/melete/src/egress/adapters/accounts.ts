/**
 * Whose account a command-line token is, asked of the service it belongs to,
 * from this server: on connecting (a refused token is never kept) and when the
 * connection's health is checked.
 */
import { githubAccount } from './github.ts';
import { gitlabAccount } from './gitlab.ts';
import { npmAccount } from './npm.ts';

export type CommandLineAccountCheck =
  | { ok: true; login: string }
  | { ok: false; code: 'credential_refused' | 'unavailable' };

/** Where each service's check goes. Only a test replaces them. */
export type CommandLineCheckOptions = {
  fetch?: typeof fetch;
  githubApi?: string;
  gitlabApi?: string;
  npmRegistry?: string;
};

/** The service's own name, as a person reads it in a message. */
export const COMMAND_LINE_SERVICE = { github: 'GitHub', gitlab: 'GitLab', npm: 'npm' } as const;
export type CommandLineService = keyof typeof COMMAND_LINE_SERVICE;

export function commandLineAccount(
  service: CommandLineService,
  token: string,
  options: CommandLineCheckOptions & { signal?: AbortSignal },
): Promise<CommandLineAccountCheck> {
  const common = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  if (service === 'gitlab')
    return gitlabAccount(token, {
      ...common,
      ...(options.gitlabApi ? { api: options.gitlabApi } : {}),
    });
  if (service === 'npm')
    return npmAccount(token, {
      ...common,
      ...(options.npmRegistry ? { registry: options.npmRegistry } : {}),
    });
  return githubAccount(token, {
    ...common,
    ...(options.githubApi ? { api: options.githubApi } : {}),
  });
}
