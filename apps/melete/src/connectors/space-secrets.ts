/**
 * Sealed secrets a person gave the agent, kept by name in their space.
 *
 * The value is sealed like every other secret (connectors/secrets.ts) and the
 * `space_secret` row holds only its name, what it is for, the one host it is
 * for when there is one, and the sealed record it points at. Nothing here
 * hands a value to a caller except `forCommand`, whose values go into one
 * command's environment and into the redaction of what that command printed.
 * Lists and refusals name a secret; they never carry what it holds.
 */
import { sealedSecretNameRefusal } from '@melete/contracts';
import type { Sql } from 'postgres';
import type { Query } from '../broker/records.ts';
import type { SealedSecretStore } from './secrets.ts';

export type SpaceSecretRow = {
  name: string;
  purpose: string;
  host: string | null;
  created_at: string;
  updated_at: string;
};

/** What one command is given: the environment it runs with, and every value to redact. */
export type CommandSecrets = {
  env: Record<string, string>;
  /** The names the command was given, in the order it named them. */
  used: string[];
  /** Every value the command was given, to keep out of what it printed. */
  values: string[];
};

/** Why a command that named a secret cannot run. Its words name the secret, never its value. */
export class SecretRefusal extends Error {
  override readonly name = 'SecretRefusal';
}

/** The most secrets one command may name. */
export const MAX_COMMAND_SECRETS = 8;

export class SpaceSecrets {
  constructor(
    private readonly sql: Sql,
    private readonly store: SealedSecretStore,
  ) {}

  /**
   * Seals `value` in the space under `name`, replacing what was kept there
   * before. The earlier sealed record is removed once the row points at the
   * new one, so an old value never stays behind.
   */
  async save(
    input: {
      spaceId: string;
      name: string;
      purpose: string;
      host?: string | null;
      principalId?: string | null;
    },
    value: string,
    tx: Query = this.sql,
  ): Promise<void> {
    const refused = sealedSecretNameRefusal(input.name);
    if (refused) throw new SecretRefusal(refused);
    if (!value) throw new SecretRefusal('A secret cannot be empty.');
    const ref = await this.store.put(input.spaceId, value);
    const [before] = await tx`select secret_ref from space_secret
      where space_id = ${input.spaceId} and name = ${input.name} for update`;
    await tx`insert into space_secret (space_id, name, purpose, host, secret_ref, principal_id)
      values (${input.spaceId}, ${input.name}, ${input.purpose}, ${input.host ?? null},
        ${ref}, ${input.principalId ?? null})
      on conflict (space_id, name) do update set purpose = excluded.purpose,
        host = excluded.host, secret_ref = excluded.secret_ref,
        principal_id = excluded.principal_id, updated_at = now()`;
    if (before?.secret_ref) await this.store.forget(String(before.secret_ref), input.spaceId);
  }

  /** The space's secrets by name and purpose, oldest first. Never a value. */
  async list(spaceId: string): Promise<SpaceSecretRow[]> {
    const rows = await this.sql`select name, purpose, host, created_at, updated_at
      from space_secret where space_id = ${spaceId} order by created_at, name`;
    return rows.map((row) => ({
      name: String(row.name),
      purpose: String(row.purpose),
      host: (row.host as string | null) ?? null,
      created_at: new Date(row.created_at as string).toISOString(),
      updated_at: new Date(row.updated_at as string).toISOString(),
    }));
  }

  /** Removes one secret for good, its sealed record with it. Says whether there was one. */
  async remove(spaceId: string, name: string): Promise<boolean> {
    const [gone] = await this.sql`delete from space_secret
      where space_id = ${spaceId} and name = ${name} returning secret_ref`;
    if (!gone) return false;
    await this.store.forget(String(gone.secret_ref), spaceId);
    return true;
  }

  /**
   * The secrets one command in this space named, opened for it. A name that
   * is not sealed in this space, and one kept for a single host, is refused
   * before anything runs: another space's secret of the same name is never
   * looked at.
   */
  async forCommand(
    spaceId: string,
    names: readonly string[],
    /** Names the command refers to: only those sealed here for commands are given. */
    refs: readonly string[] = [],
  ): Promise<CommandSecrets> {
    const referred = refs.length
      ? await this.sql`select name from space_secret
          where space_id = ${spaceId} and host is null and name = any(${[...refs]})`
      : [];
    const wanted = [...new Set([...names, ...referred.map((row) => String(row.name))])];
    if (!wanted.length) return { env: {}, used: [], values: [] };
    if (wanted.length > MAX_COMMAND_SECRETS)
      throw new SecretRefusal(`A command may use at most ${MAX_COMMAND_SECRETS} secrets.`);
    const rows = await this.sql`select name, host, secret_ref from space_secret
      where space_id = ${spaceId} and name = any(${wanted})`;
    const byName = new Map(rows.map((row) => [String(row.name), row]));
    const missing = wanted.filter((name) => !byName.has(name));
    if (missing.length)
      throw new SecretRefusal(
        `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not saved in this space, so the command was not run. Ask the person for ${missing.length === 1 ? 'it' : 'them'} with ask_person and a secret.`,
      );
    const env: Record<string, string> = {};
    const values: string[] = [];
    for (const name of wanted) {
      const row = byName.get(name);
      if (row?.host)
        throw new SecretRefusal(
          `${name} is kept for ${String(row.host)} only and is never put in a command's environment, so the command was not run.`,
        );
      try {
        const value = await this.store.withSecret(String(row?.secret_ref), spaceId, async (v) => v);
        env[name] = value;
        values.push(value);
      } catch {
        throw new SecretRefusal(
          `${name} could not be opened, so the command was not run. Ask the person to give it again.`,
        );
      }
    }
    return { env, used: wanted, values };
  }

  /** Every value sealed in this space for commands, to keep out of what a process printed. */
  async valuesOf(spaceId: string): Promise<string[]> {
    const rows = await this.sql`select secret_ref from space_secret
      where space_id = ${spaceId} and host is null`;
    const values: string[] = [];
    for (const row of rows) {
      const value = await this.store
        .withSecret(String(row.secret_ref), spaceId, async (v) => v)
        .catch(() => null);
      if (value) values.push(value);
    }
    return values;
  }
}
