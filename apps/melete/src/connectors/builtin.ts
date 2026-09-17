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
 * generation passes once a speech-capable provider is configured; it is a
 * `spend`, so every call still needs an approval and a budget reservation.
 * In-cell execution passes only where the cell is a container, because the
 * container is what bounds a command. Mail, calendars, MCP servers and the
 * browser worker need a credential or an endpoint, and the test destination is
 * a fixture, so none of them is ever a default.
 *
 * A default is an ordinary `connection` row. It can be revoked like any other,
 * and a space that already grants one of a default's tools through a row of
 * its own, in any state, is left exactly as it is.
 */
import type { ConnectorManifest } from '@melete/contracts';
import type { Sql } from 'postgres';
import { capabilitiesFromEnv } from '../gateway/capabilities.ts';
import { newId } from '../ids.ts';
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
};

type Builtin = {
  key: string;
  provider: string;
  label: string;
  scopes: string[];
  when?: (environment: BuiltinEnvironment) => boolean;
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
    label: 'Finished work',
    scopes: grants(artifactsManifest),
  },
  {
    key: 'generation',
    provider: 'generation',
    label: 'Speech',
    scopes: ['audio.synthesize'],
    when: (environment) => environment.speechConfigured,
  },
  {
    key: 'exec',
    provider: 'exec',
    label: 'Code in the workspace',
    scopes: grants(execManifest),
    when: (environment) => environment.cellIsolated,
  },
];

export function builtinEnvironment(env: {
  MELETE_RUNTIME_ADAPTER: string;
  MELETE_RUNTIME_SUPERVISOR: string;
  OPENAI_API_KEY?: string;
  OPENAI_COMPAT_BASE_URL?: string;
  MELETE_ENABLE_FAKE_PROVIDER?: boolean;
}): BuiltinEnvironment {
  return {
    cellIsolated:
      env.MELETE_RUNTIME_ADAPTER === 'docker' ||
      (env.MELETE_RUNTIME_ADAPTER === 'hermes' && env.MELETE_RUNTIME_SUPERVISOR === 'docker'),
    speechConfigured:
      capabilitiesFromEnv({
        OPENAI_API_KEY: env.OPENAI_API_KEY,
        OPENAI_COMPAT_BASE_URL: env.OPENAI_COMPAT_BASE_URL,
        MELETE_ENABLE_FAKE_PROVIDER: String(env.MELETE_ENABLE_FAKE_PROVIDER ?? false),
      }).speech !== null,
  };
}

export type CreatedBuiltin = {
  id: string;
  spaceId: string;
  provider: string;
  secretRef: null;
  configuration: { builtin: string };
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
          and not exists (
            select 1 from connection c, jsonb_array_elements_text(c.scopes) granted
            where c.space_id = s.id and c.provider = ${builtin.provider}
              and granted = any(${builtin.scopes}))
        order by s.id`;
      for (const space of spaces) {
        const id = newId('conn');
        const configuration = { builtin: builtin.key };
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
