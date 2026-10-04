/**
 * `melete-cells`: the service that holds the Docker socket, so the Melete
 * service does not (deploy/docker-compose.yml). It reads only the settings
 * below: no database address, no master key, no model or connector key.
 *
 * Its key is written once into its own volume (MELETE_CELLS_KEY_FILE), which
 * the Melete service mounts read-only, so nothing has to be added to
 * deploy/.env for an installation to gain it.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_STDIO_IMAGES } from '../connectors/mcp-stdio-docker.ts';
import { startCellsServer } from './server.ts';

/** The key in `path`, written there first if there is none. */
export function cellsKey(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    try {
      writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o440 });
    } catch (error) {
      // Another start wrote it first; that one is the key.
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  }
  const key = readFileSync(path, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error(`${path} does not hold a cell service key`);
  return key;
}

function setting(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

if (import.meta.main) {
  const bind = setting('MELETE_CELLS_BIND', '0.0.0.0:8791');
  const [hostname = '0.0.0.0', port = '8791'] = bind.split(/:(?=\d+$)/);
  const project = setting('MELETE_COMPOSE_PROJECT', 'melete');
  const server = startCellsServer({
    socket: setting('MELETE_DOCKER_SOCKET', '/var/run/docker.sock'),
    key: cellsKey(setting('MELETE_CELLS_KEY_FILE')),
    hostname,
    port: Number(port),
    project,
    sandboxProject: process.env.MELETE_SANDBOX_PROJECT?.trim() || undefined,
    runtimeImage: setting('MELETE_RUNTIME_IMAGE'),
    sandboxImage: process.env.MELETE_SANDBOX_DOCKER_IMAGE?.trim() || undefined,
    mcpImages: [
      process.env.MELETE_MCP_NODE_IMAGE?.trim() || DEFAULT_STDIO_IMAGES.node,
      process.env.MELETE_MCP_PYTHON_IMAGE?.trim() || DEFAULT_STDIO_IMAGES.python,
    ],
    workVolume: setting('MELETE_WORK_VOLUME', `${project}_work`),
  });
  process.stdout.write(`melete-cells listening on ${server.hostname}:${server.port}\n`);
  const stop = () => {
    server.stop(true);
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
