/**
 * The connections every space has without anyone installing them.
 *
 * A connector is a default when all three hold, judged from its own code:
 *
 * 1. It needs no credential and no endpoint of its own to be constructed.
 * 2. Everything it does is either contained in the job's workspace and the
 *    space's own directory, or a guarded read, or waits for a payload-bound
 *    approval. The broker admits it exactly as it admits any other connection.
 * 3. It does not lean on isolation the running deployment lacks.
 *
 * Files, web fetch and artifact publishing pass all three everywhere. Speech
 * generation passes once a speech-capable provider is configured, and
 * transcription once a provider that transcribes is; each is a `spend`, so
 * every call still needs an approval and a budget reservation. Transcription
 * is its own row beside Speech, so a space that already has Speech gains it
 * when such a provider is added, and either can be revoked alone.
 * In-cell execution passes only where the cell is a container, because the
 * container is what bounds a command. A sandbox passes where the operator asked
 * for one on this service's own Docker engine (`MELETE_SANDBOX_PROVIDER=docker`):
 * it needs no key, runs in a container of its own, and every command, file and
 * desktop action still goes through the broker. Mail, calendars, MCP servers and the
 * browser worker need a credential or an endpoint, and the test destination is
 * a fixture, so none of them is ever a default.
 *
 * A default is an ordinary `connection` row. It can be revoked like any other,
 * and a space that already grants one of a default's tools through a row of
 * its own, in any state, is left exactly as it is.
 */
import {
  CONNECTION_KIND_SCOPES,
  type ConnectorManifest,
  type SandboxConnectionConfig,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { capabilitiesFromEnv } from '../gateway/capabilities.ts';
import { newId } from '../ids.ts';
import { type DockerSandboxEnv, defaultSandboxConfig } from '../sandbox/docker-default.ts';
import { artifactsManifest } from './artifacts.ts';
import { execManifest } from './exec.ts';
import { filesManifest } from './files.ts';
import { webManifest } from './web.ts';

/** Procedure evaluation runs each arm in a throwaway space that must stay without tools. */
const EVALUATION_SPACE_PATH = 'evaluation/';
const BUILTIN_LOCK = 31003104;

export type BuiltinEnvironment = {
  /** True when attempts run in a container rather than as a process of the service user. */
  cellIsolated: boolean;
  /** True when a speech-capable provider is configured. */
  speechConfigured: boolean;
  /** True when a provider that transcribes is configured. */
  transcriptionConfigured: boolean;
  /** The sandbox every space is given, or null when the deployment asked for none. */
  sandbox?: SandboxConnectionConfig | null;
};

type Builtin = {
  key: string;
  provider: string;
  label: string;
  scopes: string[];
  when?: (environment: BuiltinEnvironment) => boolean;
  /** What the row stores beside the builtin marker, for a default that carries its own settings. */
  configuration?: (environment: BuiltinEnvironment) => Record<string, unknown>;
};

const grants = (manifest: ConnectorManifest): string[] => [
  ...new Set(manifest.tools.flatMap((tool) => [tool.name, ...tool.required_scopes])),
];

export const BUILTIN_CONNECTIONS: readonly Builtin[] = [
  { key: 'files', provider: 'files', label: 'Files', scopes: grants(filesManifest) },
  { key: 'web', provider: 'web', label: 'Web', scopes: grants(webManifest) },
  {
    key: 'artifacts',
    provider: 'artifacts',
    label: 'Saved results',
    scopes: grants(artifactsManifest),
  },
  {
    key: 'generation',
    provider: 'generation',
    label: 'Voice',
    scopes: ['audio.synthesize'],
    when: (environment) => environment.speechConfigured,
  },
  {
    key: 'transcription',
    provider: 'generation',
    label: 'Voice to text',
    scopes: ['audio.transcribe'],
    when: (environment) => environment.transcriptionConfigured,
  },
  {
    key: 'exec',
    provider: 'exec',
    label: 'Code runner',
    scopes: grants(execManifest),
    when: (environment) => environment.cellIsolated,
  },
  {
    key: 'sandbox',
    provider: 'sandbox',
    label: 'Computer',
    scopes: [...CONNECTION_KIND_SCOPES.sandbox],
    when: (environment) => Boolean(environment.sandbox),
    // Read back by the connector factory as any other sandbox connection.
    configuration: (environment) => ({ kind: 'sandbox', sandbox: environment.sandbox }),
  },
];

/**
 * The name a default connection is shown by. A row keeps the label it was made
 * with, so one made before a default was renamed reads by its current name.
 */
export function builtinLabel(configuration: { builtin?: unknown } | null | undefined) {
  const key = configuration?.builtin;
  if (typeof key !== 'string') return null;
  return BUILTIN_CONNECTIONS.find((builtin) => builtin.key === key)?.label ?? null;
}

export function builtinEnvironment(
  env: {
    MELETE_RUNTIME_ADAPTER: string;
    MELETE_RUNTIME_SUPERVISOR: string;
    ELEVENLABS_API_KEY?: string;
    OPENAI_API_KEY?: string;
    OPENAI_COMPAT_BASE_URL?: string;
    MELETE_ENABLE_FAKE_PROVIDER?: boolean;
  } & Partial<Omit<DockerSandboxEnv, 'MELETE_RUNTIME_ADAPTER'>>,
): BuiltinEnvironment {
  const capabilities = capabilitiesFromEnv({
    ELEVENLABS_API_KEY: env.ELEVENLABS_API_KEY,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    OPENAI_COMPAT_BASE_URL: env.OPENAI_COMPAT_BASE_URL,
    MELETE_ENABLE_FAKE_PROVIDER: String(env.MELETE_ENABLE_FAKE_PROVIDER ?? false),
  });
  return {
    sandbox: defaultSandboxConfig({
      ...env,
      MELETE_DOCKER_SOCKET: env.MELETE_DOCKER_SOCKET ?? '/var/run/docker.sock',
    }),
    cellIsolated:
      env.MELETE_RUNTIME_ADAPTER === 'docker' ||
      (env.MELETE_RUNTIME_ADAPTER === 'hermes' && env.MELETE_RUNTIME_SUPERVISOR === 'docker'),
    speechConfigured: capabilities.speech !== null,
    transcriptionConfigured: capabilities.transcription !== null,
  };
}

export type CreatedBuiltin = {
  id: string;
  spaceId: string;
  provider: string;
  secretRef: null;
  configuration: { builtin: string } & Record<string, unknown>;
};

/**
 * Give every space, or one, the defaults it lacks. Safe to call at every start
 * and after every account change: a second call finds nothing to do, and a
 * default someone revoked is still a row, so it is not made again.
 */
export async function ensureBuiltinConnections(
  sql: Sql,
  environment: BuiltinEnvironment,
  spaceId?: string,
): Promise<CreatedBuiltin[]> {
  const wanted = BUILTIN_CONNECTIONS.filter((builtin) => builtin.when?.(environment) ?? true);
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${BUILTIN_LOCK})`;
    const created: CreatedBuiltin[] = [];
    for (const builtin of wanted) {
      const spaces = await tx<{ id: string }[]>`select s.id from space s
        where (${spaceId ?? null}::text is null or s.id = ${spaceId ?? null})
          and s.git_path not like ${`${EVALUATION_SPACE_PATH}%`}
          -- A space being removed is never furnished again, by a request that
          -- lands mid-sweep or by the pass over every space at startup. Without
          -- this, either one puts back the connections the sweep just deleted.
          and s.removed_at is null
          and not exists (
            select 1 from connection c, jsonb_array_elements_text(c.scopes) granted
            where c.space_id = s.id and c.provider = ${builtin.provider}
              and granted = any(${builtin.scopes}))
        order by s.id`;
      for (const space of spaces) {
        const id = newId('conn');
        const configuration = {
          ...builtin.configuration?.(environment),
          builtin: builtin.key,
        };
        await tx`insert into connection
          (id, space_id, provider, label, scopes, configuration, setup_state, status, health)
          values (${id}, ${space.id}, ${builtin.provider}, ${builtin.label},
            ${JSON.stringify(builtin.scopes)}::jsonb, ${JSON.stringify(configuration)}::jsonb,
            'connected', 'active', 'ok')`;
        created.push({
          id,
          spaceId: space.id,
          provider: builtin.provider,
          secretRef: null,
          configuration,
        });
      }
    }
    return created;
  });
}
