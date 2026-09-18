/**
 * The tailnet address of an installation: the settings that name it, and the
 * origin that name becomes once the node has joined.
 *
 * The two belong together, because they are one chain. TS_HOSTNAME names the
 * node, MagicDNS publishes that name under the tailnet, the control plane
 * issues a certificate for it, and the resulting https:// address is the
 * origin the web client must accept. configure.ts settles the first link; this
 * script reads the last one back off the running node.
 *
 * The web client checks that a browser's Origin matches the address the
 * installation is reached at, and over the tailnet that address is the node's
 * certificate domain, which the control plane assigns. Nobody should have to
 * copy it by hand, so this asks the running node for it:
 *
 *   bun run deploy/scripts/tailscale-origin.ts
 *
 * It reads `tailscale status --json` inside the node, takes the certificate
 * domain, sets MELETE_WEB_ORIGIN in deploy/.env and prints the one command
 * that gives the web service the new setting. Nothing is restarted here: the
 * change is stated, and applying it stays a decision.
 *
 * Every judgement is a pure function over the recorded JSON and over the file's
 * text, and the command runner and the three filesystem steps are injected, so
 * the tests cover the whole path without Docker and without a tailnet.
 */
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CommandOutput } from '../../apps/melete/src/runtime/docker-engine.ts';

export type CommandRunner = (command: readonly string[]) => Promise<CommandOutput>;

/**
 * The fields of `tailscale status --json` this reads.
 *
 * `CertDomains` are the names the control plane will issue a certificate for,
 * without a trailing dot, and it is what Serve terminates HTTPS on, so it is
 * the address a browser uses. `Self.DNSName` is the node's own FQDN and ends
 * with a dot; it is the fallback, and it is written as the origin, because a
 * tailnet with HTTPS certificates disabled reports no certificate domain while
 * the name it will be issued for is already settled. Turning the setting on
 * afterwards changes nothing that was written here. A node still joining has
 * neither, and that is what the report calls no origin yet.
 */
export type TailscaleStatus = {
  CertDomains?: readonly unknown[] | null;
  Self?: { DNSName?: unknown } | null;
  BackendState?: unknown;
};

export const STATUS_COMMAND = [
  'docker',
  'compose',
  '-f',
  'deploy/docker-compose.yml',
  '-f',
  'deploy/docker-compose.tailscale.yml',
  'exec',
  '-T',
  'tailscale',
  'tailscale',
  'status',
  '--json',
] as const;

const ORIGIN_SETTING = 'MELETE_WEB_ORIGIN';
/** A dotted DNS name, which is what both fields hold and all a URL host may be. */
const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]{1,63})+$/;
/** A literal address is not a certificate domain, and no certificate covers one. */
const DOTTED_QUAD = /^\d+(?:\.\d+){3}$/;
/** A node name is one DNS label, because MagicDNS publishes it as one. */
const NODE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const DEFAULT_NODE_NAME = 'melete';
export const TAILSCALE_USAGE =
  'Usage: bun run deploy/scripts/configure.ts [--fake] [--tailscale [--tailscale-hostname name]]';

/**
 * The node name `configure.ts --tailscale` settles, or null when the tailnet
 * settings were not asked for.
 *
 * A name is refused rather than trimmed into something else, because it ends up
 * in the address the owner types and in the certificate the node is issued.
 * `--tailscale-hostname` without `--tailscale` is a mistake worth naming: it
 * would otherwise be accepted and silently do nothing.
 */
export function tailscaleNodeName(argv: readonly string[]): string | null {
  const wanted = argv.includes('--tailscale');
  const at = argv.indexOf('--tailscale-hostname');
  if (at < 0) return wanted ? DEFAULT_NODE_NAME : null;
  if (!wanted) throw new Error(`--tailscale-hostname needs --tailscale. ${TAILSCALE_USAGE}`);
  const name = argv[at + 1] ?? '';
  if (!NODE_NAME.test(name))
    throw new Error(
      `--tailscale-hostname ${name || '(empty)'} is not a node name. Use lower-case letters, digits and hyphens, for example ${DEFAULT_NODE_NAME}.`,
    );
  return name;
}

/**
 * What is still left to do after the file is written, in the order it is done.
 *
 * The auth key is deliberately not generated or prompted for here: it comes
 * from the Tailscale admin console, it is the one credential this file cannot
 * produce, and printing it back would put it in a terminal history.
 */
export function tailscaleNotes(nodeName: string): string[] {
  return [
    `Tailscale settings written: TS_HOSTNAME=${nodeName}, and TS_AUTHKEY left empty.`,
    'Paste an auth key from the Tailscale admin console into TS_AUTHKEY in deploy/.env.',
    `Then start the overlay and run deploy/scripts/tailscale-origin.ts, which sets ${ORIGIN_SETTING} to the node's https:// address. The web client refuses a browser whose origin is anything else, so leave it to that script rather than guessing the name.`,
    'See docs/DEPLOYMENT.md, "Tailscale".',
  ];
}

/**
 * The certificate domain the node answers HTTPS on, or null.
 *
 * The first certificate domain is preferred over the node's own name because
 * it is exactly the set Serve can terminate TLS for. Both are normalised the
 * same way — lower case, no trailing dot — and anything that is not a plain
 * dotted name is refused rather than pasted into a URL.
 */
export function certDomain(status: TailscaleStatus): string | null {
  const candidates = [
    ...(Array.isArray(status.CertDomains) ? status.CertDomains : []),
    status.Self?.DNSName,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const domain = candidate.trim().replace(/\.$/, '').toLowerCase();
    if (DOMAIN.test(domain) && !DOTTED_QUAD.test(domain)) return domain;
  }
  return null;
}

/** The origin a browser on the tailnet sends, which is the one the web client accepts. */
export function tailnetOrigin(domain: string): string {
  return `https://${domain}`;
}

/**
 * deploy/.env with MELETE_WEB_ORIGIN set to this origin.
 *
 * The setting is rewritten where it already stands, so the file keeps its
 * comments and its order; a file that never had the line gets it appended. An
 * unchanged file is reported as unchanged, so the caller can say so instead of
 * asking for a restart nothing needs.
 */
export function withOrigin(envFile: string, origin: string): { text: string; changed: boolean } {
  const line = `${ORIGIN_SETTING}=${origin}`;
  const setting = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${ORIGIN_SETTING}[ \\t]*=.*$`, 'm');
  if (!setting.test(envFile)) {
    const separator = envFile === '' || envFile.endsWith('\n') ? '' : '\n';
    return { text: `${envFile}${separator}${line}\n`, changed: true };
  }
  const text = envFile.replace(setting, line);
  return { text, changed: text !== envFile };
}

/**
 * The one command that gives the running web service the new origin.
 *
 * `--no-deps` keeps it to the web service. Without it the command also brings
 * up what web depends on, from the two files named here, so an installation
 * that runs a further override would have those services recreated without it.
 * Applying one setting may not rebuild the rest of the stack behind the reader.
 */
export function recreateCommand(): string {
  return [
    'docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.tailscale.yml',
    'up -d --no-deps --force-recreate web',
  ].join(' ');
}

/**
 * What the run writes and prints, so the test reads the whole outcome.
 *
 * `text` is present only when deploy/.env has to change, so a second run on a
 * settled installation rewrites nothing and asks for no restart.
 */
export type OriginReport = { found: boolean; lines: string[]; text?: string };

export function originReport(status: TailscaleStatus, envFile: string): OriginReport {
  const domain = certDomain(status);
  if (domain === null)
    return {
      found: false,
      lines: [
        'The node reports no certificate domain yet.',
        'Enable HTTPS certificates for the tailnet, then wait for the node to finish joining.',
        `Its state is ${typeof status.BackendState === 'string' ? status.BackendState : 'unknown'}.`,
      ],
    };
  const origin = tailnetOrigin(domain);
  const { text, changed } = withOrigin(envFile, origin);
  return {
    found: true,
    lines: [
      `${ORIGIN_SETTING}=${origin}`,
      changed
        ? `Written to deploy/.env. Give it to the running web service with:\n  ${recreateCommand()}`
        : 'deploy/.env already held this origin; the web service needs nothing.',
    ],
    ...(changed ? { text } : {}),
  };
}

/** The mode deploy/.env is created with, and the mode its replacement carries. */
export const ENV_FILE_MODE = 0o600;

/**
 * The three filesystem steps `replaceFile` takes, injected so the order of them
 * is something a test can watch without a disk that can be made to fail.
 *
 * `write` must refuse a path that already exists, so two runs at once cannot
 * share a half-written temporary.
 */
export type FileReplacer = {
  write: (path: string, text: string, mode: number) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
};

/**
 * Put `text` at `path`, leaving whatever is already there whole until it does.
 *
 * deploy/.env holds MELETE_MASTER_KEY, without which the installation cannot
 * read its own stored credentials. Writing over it in place truncates it first,
 * so a run interrupted between the truncation and the write — a killed
 * terminal, a full disk, a lost host — would leave the key gone and no copy of
 * it anywhere. The new text goes to a temporary file beside the original
 * instead, with the same mode so the key is never briefly readable by anyone
 * else, and one rename puts it in place. Until that rename the original is
 * untouched; after it the file is either wholly the old text or wholly the new.
 * The temporary is in the same directory because a rename is one step only
 * within a filesystem. A failed write or rename takes the temporary away and
 * reports, rather than leaving a stray file holding the key.
 */
export async function replaceFile(
  path: string,
  text: string,
  file: FileReplacer,
  mode: number = ENV_FILE_MODE,
): Promise<void> {
  const temporary = `${path}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    await file.write(temporary, text, mode);
    await file.rename(temporary, path);
  } catch (error) {
    await file.remove(temporary).catch(() => {});
    throw error;
  }
}

/** The replacer over the real filesystem. `wx` is what refuses an existing path. */
export const fileReplacer: FileReplacer = {
  write: async (path, text, mode) => {
    await writeFile(path, text, { flag: 'wx', mode });
  },
  rename: async (from, to) => {
    await rename(from, to);
  },
  remove: async (path) => {
    await rm(path, { force: true });
  },
};

export async function readStatus(run: CommandRunner): Promise<TailscaleStatus> {
  const result = await run(STATUS_COMMAND);
  if (result.code !== 0)
    throw new Error(
      `${STATUS_COMMAND.slice(0, 2).join(' ')} could not ask the node for its status. Start the overlay first.\n${result.stderr.trim().slice(-2000)}`,
    );
  try {
    return JSON.parse(result.stdout) as TailscaleStatus;
  } catch {
    throw new Error('The node did not answer with JSON status.');
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '../..');
  const envPath = join(root, 'deploy/.env');
  const envFile = await readFile(envPath, 'utf8').catch(() => {
    throw new Error('deploy/.env is missing. Run deploy/scripts/configure.ts first.');
  });
  const report = originReport(
    await readStatus(async (command) => {
      const child = Bun.spawn([...command], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    }),
    envFile,
  );
  if (report.text !== undefined) await replaceFile(envPath, report.text, fileReplacer);
  for (const line of report.lines) process.stdout.write(`${line}\n`);
  process.exit(report.found ? 0 : 1);
}
