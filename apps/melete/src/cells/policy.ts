/**
 * What the cell service accepts from the Melete service. The service holds no
 * Docker socket; it asks `melete-cells`, which holds it, and every request is
 * judged here first. Three container profiles are fixed in code:
 *
 * - `runtime`: an attempt's engine, from the runtime image the operator named,
 *   on its own internal network, with its job's workspace and its own home;
 * - `sandbox`: an agent's computer, from the sandbox image the operator named,
 *   with no network or its own internal one, and its two volumes;
 * - `mcp`: a stdio MCP server (or its package preparation), from an image
 *   pulled by digest, with no network or its own internal one, and its volumes.
 *
 * Each runs as its fixed non-root user on a read-only root, with every
 * capability dropped and no privilege escalation. Anything else is refused:
 * another image, a host path or a volume another profile owns, privileged
 * mode, host namespaces, devices, added capabilities, a network that is not
 * the container's own internal one, a volume driver, or an engine call outside
 * the short list below. Requests that act on an existing container, network,
 * volume or exec act only on ones a profile owns, so the API can reach neither
 * the database's container nor this one.
 *
 * The judgement is pure apart from `lookup`, which reads the engine, so the
 * tests exercise it without Docker.
 */

export type Profile = 'runtime' | 'sandbox' | 'mcp';

export type CellsPolicyConfig = {
  /** The Compose project: names and labels of attempt cells and MCP servers. */
  project: string;
  /** The label sandbox computers carry for this installation (MELETE_SANDBOX_PROJECT). */
  sandboxProject?: string;
  /** The engine image attempt cells run (MELETE_RUNTIME_IMAGE). */
  runtimeImage: string;
  /** The computer image agents get (MELETE_SANDBOX_DOCKER_IMAGE). */
  sandboxImage?: string;
  /** The images stdio MCP runners pull by name, beside any image pinned by digest. */
  mcpImages: readonly string[];
  /** The workspace volume attempt cells mount one job directory of. */
  workVolume: string;
};

type Labels = Record<string, string>;

/** What the policy reads from the engine to judge a request. Null when it does not exist. */
export type CellsLookup = {
  container(id: string): Promise<{
    Id: string;
    Name?: string;
    Config?: { Labels?: Labels | null };
  } | null>;
  network(
    id: string,
  ): Promise<{ Id: string; Name: string; Internal?: boolean; Labels?: Labels | null } | null>;
  volume(name: string): Promise<{ Name: string; Labels?: Labels | null } | null>;
  image(reference: string): Promise<{ Id: string; RepoDigests?: string[] | null } | null>;
  exec(id: string): Promise<{ ContainerID: string } | null>;
};

export type CellsRequest = {
  method: string;
  /** The engine path without its version prefix, such as `/containers/create`. */
  path: string;
  query: URLSearchParams;
  /** The parsed JSON body, when the request has one. */
  body?: unknown;
};

export type Verdict =
  | { allow: true; redact?: 'container' | 'foreign' }
  | { allow: false; status: number; reason: string };

const OWNERS: Record<Profile, { owner: string; project: 'compose' | 'sandbox'; label: string }> = {
  runtime: {
    owner: 'com.melete.attempt-supervisor',
    project: 'compose',
    label: 'com.melete.project',
  },
  sandbox: { owner: 'com.melete.sandbox', project: 'sandbox', label: 'melete.project' },
  mcp: { owner: 'com.melete.mcp-launcher', project: 'compose', label: 'com.melete.project' },
};

/** The fixed user each profile runs as. */
export const PROFILE_USERS: Record<Profile, string> = {
  runtime: '10001:10001',
  sandbox: '10004:10004',
  mcp: '10001:10001',
};

/** The one network alias the Melete service may take on a cell's own network, by profile. */
const SERVICE_ALIASES: Record<Profile, string> = {
  runtime: 'melete',
  sandbox: 'melete-egress',
  mcp: 'melete-egress',
};

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

/** Labels the engine, Compose or a profile give meaning to; a profile container may carry only its own owner's. */
const OWNER_LABELS = new Set(Object.values(OWNERS).map(({ owner }) => owner));
const reservedLabel = (key: string) =>
  key.startsWith('com.docker.') || key.startsWith('org.opencontainers.');
const refuse = (reason: string, status = 403): Verdict => ({ allow: false, status, reason });
const allow: Verdict = { allow: true };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether a body repeats a field under another case. Go's `encoding/json`
 * matches a struct field to an incoming key case-insensitively and lets the
 * last of several matches win, so `{"Detach":false,"detach":true}` decodes to
 * `Detach:true` though we validate the `Detach:false` we read. Our exact-case
 * allow-lists already refuse a lone mis-cased key as unknown, but a key next to
 * its own case variant must be refused outright, at every level, so the object
 * the engine decodes is the one we judged.
 */
function caseCollision(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(caseCollision);
  if (!isRecord(value)) return false;
  const folded = new Map<string, string>();
  for (const key of Object.keys(value)) {
    const lower = key.toLowerCase();
    const seen = folded.get(lower);
    if (seen !== undefined && seen !== key) return true;
    folded.set(lower, key);
    if (caseCollision(value[key])) return true;
  }
  return false;
}

function projectFor(profile: Profile, config: CellsPolicyConfig): string | undefined {
  return OWNERS[profile].project === 'compose' ? config.project : config.sandboxProject;
}

/** The profile labels name, when they name exactly one of this installation's. */
export function profileOf(
  labels: Labels | null | undefined,
  config: CellsPolicyConfig,
): Profile | null {
  if (!labels) return null;
  const found = (Object.keys(OWNERS) as Profile[]).filter((profile) => {
    const { owner, label } = OWNERS[profile];
    const project = projectFor(profile, config);
    return (
      labels[owner] === 'v1' && project !== undefined && project !== '' && labels[label] === project
    );
  });
  return found.length === 1 ? (found[0] ?? null) : null;
}

const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The container names a profile may create, from its labels. */
function containerName(profile: Profile, name: string, config: CellsPolicyConfig): boolean {
  const project = literal(config.project);
  if (profile === 'runtime')
    return new RegExp(`^${project}-(att_[a-z0-9]{10,40}|spare-[a-f0-9]{24})$`).test(name);
  if (profile === 'sandbox') return /^melete-sbx-[a-z0-9][a-z0-9_.-]{0,160}$/.test(name);
  return new RegExp(`^${project}-mcp-[a-z0-9_-]{1,120}$`).test(name);
}

/** The volume names a profile may create or mount. */
function volumeName(profile: Profile, name: string, config: CellsPolicyConfig): boolean {
  const project = literal(config.project);
  if (profile === 'runtime')
    return new RegExp(`^${project}-(att_[a-z0-9]{10,40}|spare-[a-f0-9]{24})-home$`).test(name);
  if (profile === 'sandbox')
    return /^melete-sbx-[a-z0-9][a-z0-9_.-]{0,160}-(work|home)$/.test(name);
  return new RegExp(`^${project}-mcp-conn_[a-z0-9]{1,64}-(data|pkg)$`).test(name);
}

/** The network names a profile may create or run on. */
function networkName(profile: Profile, name: string, config: CellsPolicyConfig): boolean {
  const project = literal(config.project);
  if (profile === 'runtime')
    return new RegExp(`^${project}-(att_[a-z0-9]{10,40}|spare-[a-f0-9]{24})-net$`).test(name);
  if (profile === 'sandbox') return /^melete-sbx-[a-z0-9][a-z0-9_.-]{0,160}-net$/.test(name);
  return new RegExp(`^${project}-mcp-[a-z0-9_-]{1,120}-net$`).test(name);
}

/** Keys a request body may carry; any other key is a setting no profile uses. */
const CREATE_KEYS = new Set([
  'Image',
  'User',
  'WorkingDir',
  'Labels',
  'Env',
  'Entrypoint',
  'Cmd',
  'Hostname',
  'AttachStdin',
  'AttachStdout',
  'AttachStderr',
  'OpenStdin',
  'StdinOnce',
  'Tty',
  'NetworkDisabled',
  'HostConfig',
  'NetworkingConfig',
]);
const HOST_KEYS = new Set([
  'NetworkMode',
  'ReadonlyRootfs',
  'CapDrop',
  'SecurityOpt',
  'Privileged',
  'Init',
  'IpcMode',
  'PidsLimit',
  'Memory',
  'MemorySwap',
  'NanoCpus',
  'ShmSize',
  'Tmpfs',
  'Ulimits',
  'RestartPolicy',
  'LogConfig',
  'Mounts',
]);
const TMPFS_TARGETS = new Set(['/tmp', '/var/tmp', '/dev/shm']);
const ULIMITS = new Set(['fsize', 'core', 'nofile']);
const GIB = 1024 ** 3;

/** A job's directory or a spare's, as the runtime mounts one of the work volume. */
const WORK_SUBPATH =
  /^(job_[A-Za-z0-9]{10,40}|\.spare-[A-Za-z0-9_-]{1,64}(\.[a-f0-9]{24})?|\.spare-[a-f0-9]{24})$/;

const positive = (value: unknown, max: number) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= max;

/** The container-create rules every profile shares, then the profile's own. */
async function judgeCreate(
  request: CellsRequest,
  config: CellsPolicyConfig,
  lookup: CellsLookup,
): Promise<Verdict> {
  const body = request.body;
  if (!isRecord(body)) return refuse('a container is created from a JSON body');
  const name = request.query.get('name') ?? '';
  for (const key of request.query.keys())
    if (key !== 'name') return refuse(`the create option ${key} is not part of any profile`);
  const extra = Object.keys(body).filter((key) => !CREATE_KEYS.has(key));
  if (extra.length) return refuse(`no profile sets ${extra.join(', ')}`);
  const labels = isRecord(body.Labels) ? (body.Labels as Labels) : null;
  const profile = profileOf(labels, config);
  if (!profile) return refuse('the container carries no profile of this installation');
  // A Compose label would let a profile container pass for one of the stack's services.
  const reserved = Object.keys(labels ?? {}).filter(
    (key) => reservedLabel(key) || (OWNER_LABELS.has(key) && key !== OWNERS[profile].owner),
  );
  if (reserved.length) return refuse(`a profile container does not carry ${reserved.join(', ')}`);
  if (!containerName(profile, name, config))
    return refuse(`the ${profile} profile does not create a container named ${name || '(none)'}`);
  if (body.User !== PROFILE_USERS[profile])
    return refuse(`the ${profile} profile runs as ${PROFILE_USERS[profile]}`);
  if (profile !== 'mcp' && (body.Entrypoint !== undefined || body.Cmd !== undefined))
    return refuse(`the ${profile} profile runs its image's own command`);
  if (body.Tty === true) return refuse('no profile allocates a terminal');

  const host = body.HostConfig;
  if (!isRecord(host)) return refuse('a container needs its host settings');
  const hostExtra = Object.keys(host).filter((key) => !HOST_KEYS.has(key));
  if (hostExtra.length) return refuse(`no profile sets ${hostExtra.join(', ')}`);
  if (host.Privileged !== undefined && host.Privileged !== false)
    return refuse('no profile runs privileged');
  if (host.ReadonlyRootfs !== true) return refuse('every profile has a read-only root');
  if (!Array.isArray(host.CapDrop) || !host.CapDrop.includes('ALL'))
    return refuse('every profile drops every capability');
  if (
    !Array.isArray(host.SecurityOpt) ||
    host.SecurityOpt.length !== 1 ||
    host.SecurityOpt[0] !== 'no-new-privileges:true'
  )
    return refuse('every profile has no-new-privileges and no other security option');
  if (host.IpcMode !== undefined && host.IpcMode !== 'private')
    return refuse('no profile shares an IPC namespace');
  if (host.Init !== undefined && typeof host.Init !== 'boolean') return refuse('Init is a switch');
  if (!positive(host.PidsLimit, 4096)) return refuse('every profile has a process limit');
  if (!positive(host.Memory, 16 * GIB)) return refuse('every profile has a memory limit');
  if (host.MemorySwap !== undefined && host.MemorySwap !== host.Memory)
    return refuse('no profile swaps');
  if (host.NanoCpus !== undefined && !positive(host.NanoCpus, 16e9))
    return refuse('a CPU limit is a positive number');
  if (host.ShmSize !== undefined && !positive(host.ShmSize, GIB))
    return refuse('shared memory is bounded');
  if (!isRecord(host.RestartPolicy) || host.RestartPolicy.Name !== 'no')
    return refuse('no profile restarts by itself');
  const log = host.LogConfig;
  if (!isRecord(log) || !['json-file', 'none'].includes(String(log.Type)))
    return refuse('a profile logs to a bounded file or not at all');
  if (host.Tmpfs !== undefined) {
    if (!isRecord(host.Tmpfs)) return refuse('Tmpfs maps paths to options');
    for (const target of Object.keys(host.Tmpfs))
      if (!TMPFS_TARGETS.has(target)) return refuse(`no profile has memory storage at ${target}`);
  }
  if (host.Ulimits !== undefined) {
    if (!Array.isArray(host.Ulimits)) return refuse('Ulimits is a list');
    for (const limit of host.Ulimits)
      if (!isRecord(limit) || !ULIMITS.has(String(limit.Name)))
        return refuse('a profile sets only file size, core and open file limits');
  }

  // Its network: none, or its own internal network, which it alone of the profile's containers uses.
  const mode = host.NetworkMode;
  if (typeof mode !== 'string') return refuse('a container names its network');
  const endpoints = isRecord(body.NetworkingConfig)
    ? body.NetworkingConfig.EndpointsConfig
    : undefined;
  if (mode === 'none') {
    if (profile === 'runtime') return refuse('an attempt cell runs on its own network');
    if (body.NetworkDisabled !== true)
      return refuse('a container without a network has it disabled');
    if (body.NetworkingConfig !== undefined)
      return refuse('a container without a network joins none');
  } else {
    if (!networkName(profile, mode, config))
      return refuse(`the ${profile} profile does not run on the network ${mode}`);
    if (profile === 'runtime' && mode !== `${name}-net`)
      return refuse('an attempt cell runs on the network made for it');
    if (body.NetworkDisabled === true) return refuse('a container on its network has it enabled');
    if (
      endpoints !== undefined &&
      (!isRecord(endpoints) ||
        Object.keys(endpoints).length !== 1 ||
        !(mode in endpoints) ||
        !isRecord(endpoints[mode]) ||
        Object.keys(endpoints[mode] as object).length !== 0)
    )
      return refuse('a container joins its one network with no settings of its own');
    const network = await lookup.network(mode);
    if (!network || profileOf(network.Labels, config) !== profile || network.Internal !== true)
      return refuse('a container runs only on an internal network its profile made');
  }

  // Its storage: volumes of its own profile, and for an attempt, one directory of the workspace.
  if (!Array.isArray(host.Mounts)) return refuse('a container lists its mounts');
  for (const mount of host.Mounts) {
    if (!isRecord(mount) || mount.Type !== 'volume')
      return refuse('a profile mounts named volumes only, never a host path');
    const extraKeys = Object.keys(mount).filter(
      (key) => !['Type', 'Source', 'Target', 'ReadOnly', 'VolumeOptions'].includes(key),
    );
    if (extraKeys.length) return refuse(`a mount does not set ${extraKeys.join(', ')}`);
    const source = String(mount.Source ?? '');
    const options = mount.VolumeOptions;
    if (profile === 'runtime' && source === config.workVolume) {
      if (
        mount.Target !== '/work' ||
        !isRecord(options) ||
        typeof options.Subpath !== 'string' ||
        !WORK_SUBPATH.test(options.Subpath) ||
        Object.keys(options).some((key) => !['Subpath', 'NoCopy'].includes(key))
      )
        return refuse('an attempt cell mounts one job directory of the workspace at /work');
      continue;
    }
    if (options !== undefined) return refuse('only the workspace is mounted by its subpath');
    if (!volumeName(profile, source, config))
      return refuse(`the ${profile} profile does not mount the volume ${source || '(none)'}`);
    if (profile === 'runtime' && source !== `${name}-home`)
      return refuse('an attempt cell mounts the home made for it');
    const volume = await lookup.volume(source);
    if (volume && profileOf(volume.Labels, config) !== profile)
      return refuse(`the volume ${source} belongs to something else`);
  }

  // Its image: the operator's runtime or computer image, or a server image pulled by digest.
  const reference = String(body.Image ?? '');
  if (!reference) return refuse('a container names its image');
  const image = await lookup.image(reference);
  if (!image) return refuse('the image is not on this engine', 404);
  if (profile === 'runtime' || profile === 'sandbox') {
    const named = profile === 'runtime' ? config.runtimeImage : config.sandboxImage;
    const expected = named ? await lookup.image(named) : null;
    if (!expected || expected.Id !== image.Id)
      return refuse(`the ${profile} profile runs only the image the operator configured`);
  } else if (!(image.RepoDigests ?? []).length)
    return refuse('an MCP server runs an image pulled from a registry, never one built here');
  return allow;
}

/** The Melete service's own container, the one peer a cell's network may gain. */
async function isService(container: string, config: CellsPolicyConfig, lookup: CellsLookup) {
  if (!ID.test(container)) return false;
  const found = await lookup.container(container);
  const labels = found?.Config?.Labels ?? {};
  return (
    labels['com.docker.compose.project'] === config.project &&
    labels['com.docker.compose.service'] === 'melete' &&
    // Never a container made through a profile, whatever else it is labelled.
    !Object.keys(labels).some((key) => OWNER_LABELS.has(key))
  );
}

/** The profile an existing container belongs to, or null. */
async function containerProfile(id: string, config: CellsPolicyConfig, lookup: CellsLookup) {
  if (!ID.test(id)) return null;
  const found = await lookup.container(id);
  return found ? profileOf(found.Config?.Labels, config) : null;
}

/** A list filtered to one profile's owner label, so nothing else is enumerated. */
function ownedFilter(query: URLSearchParams): boolean {
  try {
    const filters = JSON.parse(query.get('filters') ?? '') as { label?: unknown };
    const labels = Array.isArray(filters.label) ? filters.label.map(String) : [];
    return Object.values(OWNERS).some(({ owner }) => labels.includes(`${owner}=v1`));
  } catch {
    return false;
  }
}

const onlyKeys = (query: URLSearchParams, allowed: readonly string[]) =>
  [...query.keys()].every((key) => allowed.includes(key));

/** Image references a pull may name: the configured runners', or one pinned by its digest. */
function pullable(reference: string, config: CellsPolicyConfig): boolean {
  if (config.mcpImages.includes(reference)) return true;
  const match =
    /^([a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?)\/[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$/.exec(
      reference,
    );
  if (!match) return false;
  // A registry named by address, or as the host itself, would have the engine knock on private ports.
  const host = (match[1] ?? '').replace(/:\d+$/, '');
  const last = host.split('.').at(-1) ?? '';
  return /[a-z]/.test(last) && host !== 'localhost' && !host.endsWith('.localhost');
}

/** Judge one request to the engine. */
export async function judge(
  request: CellsRequest,
  config: CellsPolicyConfig,
  lookup: CellsLookup,
): Promise<Verdict> {
  const { method, path, query } = request;
  if (request.body !== undefined && caseCollision(request.body))
    return refuse('a request body does not repeat a field under another case');
  const parts = path.split('/').slice(1);
  // An image is named by its reference, encoded as one part; nothing else is encoded.
  const encodedAllowed = (index: number) => parts[0] === 'images' && index === 1;
  if (
    parts.some(
      (part, index) =>
        part === '' ||
        part === '.' ||
        part === '..' ||
        (part.includes('%') && !encodedAllowed(index)),
    )
  )
    return refuse('a malformed engine path');
  const [kind, id, action, ...rest] = parts;
  if (rest.length) return refuse('a malformed engine path');

  if (method === 'GET' && (path === '/version' || path === '/_ping')) return allow;

  if (kind === 'containers') {
    if (method === 'GET' && id === 'json' && action === undefined)
      return ownedFilter(query) && onlyKeys(query, ['all', 'filters'])
        ? allow
        : refuse('containers are listed by a profile owner label only');
    if (method === 'POST' && id === 'create' && action === undefined)
      return judgeCreate(request, config, lookup);
    if (!id || !ID.test(id)) return refuse('a malformed container name');
    if (method === 'GET' && action === 'json') {
      // Any container may be inspected, the service's own included, which is how it
      // finds its id and labels; one no profile owns comes back with its state and
      // labels only, never its mounts, host settings or networks.
      const found = await lookup.container(id);
      if (!found) return refuse('no such container', 404);
      return {
        allow: true,
        redact: profileOf(found.Config?.Labels, config) ? 'container' : 'foreign',
      };
    }
    const profile = await containerProfile(id, config, lookup);
    if (!profile) {
      // Docker answers 404 for a container that is not there; the client expects the same.
      if (!(await lookup.container(id))) return refuse('no such container', 404);
      return refuse('the container belongs to no profile of this installation');
    }
    if (method === 'DELETE' && action === undefined)
      return onlyKeys(query, ['force', 'v']) ? allow : refuse('a removal takes force and v only');
    if (method === 'POST' && (action === 'start' || action === 'unpause' || action === 'wait'))
      return query.size === 0 ? allow : refuse(`${action} takes no options`);
    if (method === 'POST' && action === 'stop')
      return onlyKeys(query, ['t']) ? allow : refuse('stop takes a timeout only');
    if (method === 'POST' && action === 'rename') {
      const name = query.get('name') ?? '';
      return profile === 'runtime' &&
        onlyKeys(query, ['name']) &&
        containerName('runtime', name, config) &&
        name.includes('-att_')
        ? allow
        : refuse('only a spare engine takes its attempt name');
    }
    if (method === 'GET' && action === 'logs')
      return profile === 'mcp' && onlyKeys(query, ['stdout', 'stderr', 'tail'])
        ? allow
        : refuse('only a server preparation is read back');
    if (method === 'PUT' && action === 'archive')
      return profile !== 'runtime' && onlyKeys(query, ['path', 'copyUIDGID'])
        ? allow
        : refuse('files are written only into a computer or a server');
    if (method === 'POST' && action === 'attach')
      return profile === 'mcp' ? allow : refuse('only a server is attached');
    if (method === 'POST' && action === 'exec') {
      if (profile !== 'sandbox') return refuse('commands run only in an agent computer');
      const body = request.body;
      if (!isRecord(body)) return refuse('an exec is created from a JSON body');
      const allowed = [
        'AttachStdin',
        'AttachStdout',
        'AttachStderr',
        'Tty',
        'Cmd',
        'WorkingDir',
        'Env',
      ];
      const extra = Object.keys(body).filter((key) => !allowed.includes(key));
      return extra.length ? refuse(`an exec does not set ${extra.join(', ')}`) : allow;
    }
    return refuse(`${method} ${action ?? ''} is not part of any profile`);
  }

  if (kind === 'exec') {
    if (!id || !/^[a-f0-9]{64}$/.test(id)) return refuse('a malformed exec id');
    const exec = await lookup.exec(id);
    if (!exec) return refuse('no such exec', 404);
    if ((await containerProfile(exec.ContainerID, config, lookup)) !== 'sandbox')
      return refuse('only an agent computer has commands');
    if (method === 'GET' && action === 'json') return allow;
    if (method === 'POST' && action === 'start') {
      const body = request.body;
      if (!isRecord(body)) return refuse('an exec is started from a JSON body');
      const extra = Object.keys(body).filter((key) => key !== 'Detach' && key !== 'Tty');
      if (extra.length) return refuse(`an exec start does not set ${extra.join(', ')}`);
      return body.Detach === false && body.Tty === false
        ? allow
        : refuse('an exec starts attached, without a terminal');
    }
    return refuse(`${method} exec ${action ?? ''} is not part of any profile`);
  }

  if (kind === 'networks') {
    if (method === 'GET' && id === undefined)
      return ownedFilter(query) && onlyKeys(query, ['filters'])
        ? allow
        : refuse('networks are listed by a profile owner label only');
    if (method === 'POST' && id === 'create' && action === undefined) {
      const body = request.body;
      if (!isRecord(body)) return refuse('a network is created from a JSON body');
      const allowed = ['Name', 'Driver', 'Internal', 'EnableIPv6', 'Options', 'Labels'];
      const extra = Object.keys(body).filter((key) => !allowed.includes(key));
      if (extra.length) return refuse(`no profile's network sets ${extra.join(', ')}`);
      const profile = profileOf(isRecord(body.Labels) ? (body.Labels as Labels) : null, config);
      if (!profile) return refuse('the network carries no profile of this installation');
      if (!networkName(profile, String(body.Name ?? ''), config))
        return refuse(`the ${profile} profile does not create the network ${String(body.Name)}`);
      if (body.Driver !== 'bridge' || body.Internal !== true)
        return refuse('a profile network is an internal bridge with no route out');
      if (body.EnableIPv6 !== undefined && body.EnableIPv6 !== false)
        return refuse('a profile network has no IPv6');
      const options = body.Options;
      if (
        !isRecord(options) ||
        options['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated' ||
        Object.entries(options).some(
          ([key, value]) =>
            !key.startsWith('com.docker.network.bridge.gateway_mode_ipv') || value !== 'isolated',
        )
      )
        return refuse('a profile network has no host bridge address');
      return allow;
    }
    if (!id || !ID.test(id)) return refuse('a malformed network name');
    const network = await lookup.network(id);
    if (!network) return refuse('no such network', 404);
    const profile = profileOf(network.Labels, config);
    if (!profile) return refuse('the network belongs to no profile of this installation');
    if (method === 'GET' && action === undefined) return allow;
    if (method === 'DELETE' && action === undefined) return allow;
    if (method === 'POST' && (action === 'connect' || action === 'disconnect')) {
      const body = request.body;
      if (!isRecord(body) || typeof body.Container !== 'string')
        return refuse('a network change names its container');
      if (!(await isService(body.Container, config, lookup)))
        return refuse("only the Melete service joins or leaves a cell's network");
      if (action === 'disconnect')
        return Object.keys(body).every((key) => key === 'Container' || key === 'Force')
          ? allow
          : refuse('a disconnect takes the container and force only');
      const endpoint = body.EndpointConfig;
      const aliases = isRecord(endpoint) ? endpoint.Aliases : undefined;
      return Object.keys(body).every((key) => key === 'Container' || key === 'EndpointConfig') &&
        isRecord(endpoint) &&
        Object.keys(endpoint).every((key) => key === 'Aliases') &&
        Array.isArray(aliases) &&
        aliases.length === 1 &&
        aliases[0] === SERVICE_ALIASES[profile]
        ? allow
        : refuse(`the service joins a ${profile} network as ${SERVICE_ALIASES[profile]} only`);
    }
    return refuse(`${method} network ${action ?? ''} is not part of any profile`);
  }

  if (kind === 'volumes') {
    if (method === 'GET' && id === undefined)
      return ownedFilter(query) && onlyKeys(query, ['filters'])
        ? allow
        : refuse('volumes are listed by a profile owner label only');
    if (method === 'POST' && id === 'create' && action === undefined) {
      const body = request.body;
      if (!isRecord(body)) return refuse('a volume is created from a JSON body');
      // A driver option can make a "volume" of any host path, so none is accepted.
      if (Object.keys(body).some((key) => key !== 'Name' && key !== 'Labels'))
        return refuse('a profile volume names its labels only, never a driver or its options');
      const profile = profileOf(isRecord(body.Labels) ? (body.Labels as Labels) : null, config);
      if (!profile) return refuse('the volume carries no profile of this installation');
      return volumeName(profile, String(body.Name ?? ''), config)
        ? allow
        : refuse(`the ${profile} profile does not create the volume ${String(body.Name)}`);
    }
    if (method === 'DELETE' && id && action === undefined && ID.test(id)) {
      const volume = await lookup.volume(id);
      if (!volume) return refuse('no such volume', 404);
      return profileOf(volume.Labels, config) && query.size === 0
        ? allow
        : refuse('the volume belongs to no profile of this installation');
    }
    return refuse(`${method} volume is not part of any profile`);
  }

  if (kind === 'images') {
    if (method === 'GET' && action === 'json' && id) return allow;
    if (method === 'POST' && id === 'create' && action === undefined) {
      const reference = query.get('fromImage') ?? '';
      return onlyKeys(query, ['fromImage']) && pullable(reference, config)
        ? allow
        : refuse('an image is pulled by digest, or it is one of the configured runner images');
    }
    return refuse(`${method} image is not part of any profile`);
  }

  return refuse(`${method} ${path} is not part of any profile`);
}

/**
 * A container's inspection without its environment, which may hold another
 * service's secrets. For a container no profile owns (`foreign`), only its id,
 * name, state, image and labels are kept: not its mounts, host settings or
 * network addresses.
 */
export function redactContainer(
  value: unknown,
  kind: 'container' | 'foreign' = 'container',
): unknown {
  if (!isRecord(value)) return value;
  const config = isRecord(value.Config) ? { ...value.Config } : undefined;
  if (config) delete config.Env;
  const { Args: _args, ...rest } = value;
  if (kind === 'foreign')
    return {
      Id: rest.Id,
      Name: rest.Name,
      Image: rest.Image,
      State: rest.State,
      Config: { Labels: isRecord(config?.Labels) ? config.Labels : {} },
    };
  return config ? { ...rest, Config: config } : rest;
}
