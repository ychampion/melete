/**
 * What every command is given: where the deployment directory is, and the ways
 * it reaches the machine. Each is injected so a command is tested with a fake
 * Docker and a temporary directory.
 */
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  type CommandOutput,
  spawnCommand,
} from '../../../apps/melete/src/runtime/docker-engine.ts';
import { localMachine, type MachineAccess } from '../../../apps/melete/src/runtime/docker-host.ts';

export type Run = (command: readonly string[]) => CommandOutput;

/**
 * - `free`: nothing listens there;
 * - `in_use`: something accepted a connection;
 * - `no_address`: the address is not one of this machine's, so nothing can be published on it;
 * - `unknown`: no answer in time.
 */
export type PortProbe = 'free' | 'in_use' | 'no_address' | 'unknown';

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
  /** Whether something listens on an address and port of this machine. It never binds the port. */
  probePort: (host: string, port: number) => Promise<PortProbe>;
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

/** Addresses that mean every interface: probed through loopback, which a wildcard listener also covers. */
const WILDCARD = new Set(['', '0.0.0.0', '::']);

/** Whether `address` belongs to this machine, from its interfaces. */
function localAddress(address: string): boolean {
  if (address === 'localhost' || /^127(\.\d{1,3}){3}$/.test(address)) return true;
  return Object.values(networkInterfaces()).some((entries) =>
    (entries ?? []).some((entry) => entry.address === address),
  );
}

/**
 * Asks by connecting, so the probe has no effect on the port: a bind, even a
 * brief one, could make Compose's own bind fail if it started at that moment.
 * An address that is not this machine's is never connected to, so a listener
 * on another machine is not mistaken for one here.
 */
export async function probePort(host: string, port: number): Promise<PortProbe> {
  const target = WILDCARD.has(host) ? '127.0.0.1' : host;
  if (!localAddress(target)) return 'no_address';
  return await new Promise((settle) => {
    const socket = connect({ host: target, port });
    socket.setTimeout(1_500);
    const done = (probe: PortProbe) => {
      socket.destroy();
      settle(probe);
    };
    socket.once('connect', () => done('in_use'));
    socket.once('timeout', () => done('unknown'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') done('free');
      else if (
        ['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENETUNREACH', 'EHOSTUNREACH'].includes(error.code ?? '')
      )
        done('no_address');
      else done('unknown');
    });
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
    probePort,
    fetch: (url, init) => fetch(url, init),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  };
}
