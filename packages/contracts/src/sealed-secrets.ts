/**
 * Sealed secrets: an API key, a site password or a one-time code a person
 * gives the agent for one piece of work, without it entering the chat.
 *
 * The agent asks for one by name through `ask_person`, the person types it
 * into a sealed field, and it is kept sealed in their space under that name.
 * A later command names it in `secrets` and gets it as an environment
 * variable for that command alone. Nothing here, and no route, ever carries
 * the value back out: listings name a secret and say what it is for.
 */
import { z } from 'zod';
import { timestamp } from './common.ts';
import { EXEC_ENV_NAMES } from './execution.ts';

/** An environment-variable-style name: a capital letter, then capitals, digits or underscores. */
export const SEALED_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Names a sealed secret may not take: the ones the service sets on a command
 * itself, and the ones that change how a shell or a program loader behaves.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  ...EXEC_ENV_NAMES,
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'PWD',
  'OLDPWD',
  'IFS',
  'ENV',
  'BASH_ENV',
  'PS4',
  'PROMPT_COMMAND',
  'TMPDIR',
  'LANG',
  'TERM',
]);

/** Why a name cannot hold a sealed secret, or null when it can. */
export function sealedSecretNameRefusal(name: string): string | null {
  if (!SEALED_SECRET_NAME_PATTERN.test(name))
    return 'a secret name is a capital letter followed by up to 63 capitals, digits or underscores, such as API_KEY';
  if (RESERVED_NAMES.has(name) || name.startsWith('LD_') || name.startsWith('MELETE_'))
    return `${name} is a name the computer uses itself; choose another, such as SITE_${name}`;
  return null;
}

export const sealedSecretName = z
  .string()
  .regex(SEALED_SECRET_NAME_PATTERN, 'must be a name such as API_KEY')
  .refine((name) => sealedSecretNameRefusal(name) === null, 'is a name the computer uses itself');

/** A bare host name, lower case: where a host-bound secret may only be sent. */
export const sealedSecretHost = z
  .string()
  .max(253)
  .regex(
    /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/,
    'must be a host name such as api.example.com',
  );

/** What an agent asks for: the name, what it is for and, optionally, the one host it is for. */
export const sealedSecretRequest = z.object({
  name: sealedSecretName,
  purpose: z.string().trim().min(1).max(200),
  host: sealedSecretHost.optional(),
});
export type SealedSecretRequest = z.infer<typeof sealedSecretRequest>;

/** The person's answer to a sealed question: the value, sent apart from any message. */
export const sealedSecretAnswer = z.strictObject({
  value: z.string().min(1).max(4096),
});
export type SealedSecretAnswer = z.infer<typeof sealedSecretAnswer>;

/** One sealed secret as a list shows it: never its value. */
export const sealedSecretView = z.object({
  name: sealedSecretName,
  purpose: z.string(),
  host: z.string().nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});
export type SealedSecretView = z.infer<typeof sealedSecretView>;
export const sealedSecretList = z.object({ secrets: z.array(sealedSecretView) });
export const sealedSecretDeleted = z.object({ deleted: z.boolean() });
