/**
 * What every command is given: where the deployment directory is, and the ways
 * it reaches the machine. Each is injected so a command is tested with a fake
 * Docker and a temporary directory.
 */
import { dirname, resolve } from 'node:path';
import {
  type CommandOutput,
  spawnCommand,
} from '../../../apps/melete/src/runtime/docker-engine.ts';
import { localMachine, type MachineAccess } from '../../../apps/melete/src/runtime/docker-host.ts';

export type Run = (command: readonly string[]) => CommandOutput;

export type Context = {
  /** The deployment directory: deploy/ in the checkout, or the one --deploy-dir names. */
  deployDir: string;
  /** The checkout the deployment directory belongs to. */
  root: string;
  /** Runs a command to completion and returns what it printed. */
  run: Run;
  /** Runs a command with this terminal attached, and returns its exit code. */
  attach: (command: readonly string[]) => Promise<number>;
  machine: MachineAccess;
  /** Whether nothing listens on a port on this machine yet. */
  portFree: (host: string, port: number) => Promise<boolean>;
  /** Fetch, for the one network check `doctor` makes. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  out: (text: string) => void;
  err: (text: string) => void;
};

export const DEFAULT_DEPLOY_DIR = resolve(import.meta.dir, '../../../deploy');

async function attach(command: readonly string[]): Promise<number> {
  try {
    const child = Bun.spawn([...command], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return await child.exited;
  } catch {
    return 127;
  }
}

async function portFree(host: string, port: number): Promise<boolean> {
  const { createServer } = await import('node:net');
  return await new Promise((settle) => {
    const server = createServer();
    server.once('error', () => settle(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => settle(true)));
  });
}

export function realContext(deployDir: string = DEFAULT_DEPLOY_DIR): Context {
  const dir = resolve(deployDir);
  return {
    deployDir: dir,
    root: dirname(dir),
    run: (command) => spawnCommand(command, 60_000),
    attach,
    machine: localMachine,
    portFree,
    fetch: (url, init) => fetch(url, init),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  };
}
