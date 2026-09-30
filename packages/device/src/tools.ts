/**
 * What the companion does for each request, after the checks in policy.ts.
 * Every tool has a time limit and a size limit, and none of them follows a
 * link out of a shared folder: not a symbolic link or junction, and not a file
 * with a second name elsewhere (a hard link), which is read or written as
 * neither.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { onLocalNetwork, type Resolve } from './address.ts';
import type { Capabilities, Folder } from './config.ts';
import { checkCapability, checkUrl, parsePath, Refusal, resolveInside } from './policy.ts';

export const LIMITS = {
  default_command_timeout_ms: 30_000,
  max_command_timeout_ms: 120_000,
  max_output_bytes: 65_536,
  max_file_bytes: 1_048_576,
  max_list_entries: 500,
  max_screenshot_bytes: 8_388_608,
  screenshot_timeout_ms: 30_000,
} as const;

export type ToolContext = {
  capabilities: Capabilities;
  folders: Folder[];
  /** Replaced in tests; the real one starts the operating system's own program. */
  launch?: (command: string, args: string[]) => Promise<void>;
  captureScreen?: () => Promise<Buffer>;
  /** Replaced in tests; the real one asks this computer's resolver. */
  resolve?: Resolve;
};

const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
/** O_NOFOLLOW where the platform has it, so the last component cannot be swapped for a link. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * A file with more than one name may be the same file as one outside the
 * shared folder, so it is neither read nor written. NTFS and POSIX both count
 * the names in `nlink`.
 */
function refuseHardLink(info: { nlink: number }) {
  if (info.nlink > 1)
    throw new Refusal(
      'outside_folders',
      'That file has another name elsewhere on this computer (a hard link), so it is not used.',
    );
}

async function readCapped(target: string): Promise<Buffer> {
  const file = await open(target, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Refusal('invalid_request', 'That is not a file.');
    refuseHardLink(info);
    if (info.size > LIMITS.max_file_bytes)
      throw new Refusal('too_large', 'That file is larger than 1 MB.');
    const content = await file.readFile();
    if (content.byteLength > LIMITS.max_file_bytes)
      throw new Refusal('too_large', 'That file is larger than 1 MB.');
    return content;
  } finally {
    await file.close();
  }
}

function asText(content: Buffer): { text: string; binary: boolean } {
  if (content.includes(0)) return { text: '', binary: true };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(content), binary: false };
  } catch {
    return { text: '', binary: true };
  }
}

/** Keeps the first `limit` bytes of a stream and counts the rest. */
class Capture {
  private readonly chunks: Buffer[] = [];
  private kept = 0;
  truncated = false;
  constructor(private readonly limit: number) {}
  push(chunk: Buffer) {
    const room = this.limit - this.kept;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.byteLength > room) this.truncated = true;
    const part = chunk.subarray(0, room);
    this.chunks.push(part);
    this.kept += part.byteLength;
  }
  text() {
    return new TextDecoder('utf-8').decode(Buffer.concat(this.chunks)).replace(/�$/, '');
  }
}

/** Stop a command and everything it started. */
function stopTree(pid: number | undefined) {
  if (!pid) return;
  if (platform() === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

export async function runCommand(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes?: number;
}) {
  const limit = input.maxOutputBytes ?? LIMITS.max_output_bytes;
  const stdout = new Capture(limit);
  const stderr = new Capture(limit);
  const started = performance.now();
  return new Promise<{
    exit_code: number | null;
    timed_out: boolean;
    stdout: string;
    stderr: string;
    stdout_truncated: boolean;
    stderr_truncated: boolean;
    duration_ms: number;
    cwd: string;
  }>((resolve) => {
    let timedOut = false;
    const child = spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      windowsHide: true,
      // Its own process group, so a timeout stops what it started as well.
      detached: platform() !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      stopTree(child.pid);
    }, input.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const finish = (code: number | null, error?: Error) => {
      clearTimeout(timer);
      resolve({
        exit_code: timedOut ? null : code,
        timed_out: timedOut,
        stdout: stdout.text(),
        stderr: error ? `${stderr.text()}${error.message}` : stderr.text(),
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
        duration_ms: Math.round(performance.now() - started),
        cwd: input.cwd,
      });
    };
    child.once('error', (error) => finish(null, error));
    child.once('close', (code) => finish(code));
  });
}

function launchDefault(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** The platform's own way to open an address in the default browser, with no shell in between. */
export function openCommand(url: string): [string, string[]] {
  if (platform() === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  if (platform() === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

const WINDOWS_CAPTURE = [
  'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
  '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
  '$i = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
  '$g = [System.Drawing.Graphics]::FromImage($i)',
  '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $i.Size)',
  '$i.Save($env:MELETE_SHOT, [System.Drawing.Imaging.ImageFormat]::Png)',
].join('; ');

async function captureDefault(): Promise<Buffer> {
  const file = join(tmpdir(), `melete-shot-${randomBytes(8).toString('hex')}.png`);
  const attempts: [string, string[]][] =
    platform() === 'win32'
      ? [['powershell', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_CAPTURE]]]
      : platform() === 'darwin'
        ? [['screencapture', ['-x', file]]]
        : [
            ['grim', [file]],
            ['gnome-screenshot', ['-f', file]],
            ['scrot', ['-o', file]],
            ['import', ['-window', 'root', file]],
          ];
  try {
    for (const [command, args] of attempts) {
      const ok = await new Promise<boolean>((resolve) => {
        const child = spawn(command, args, {
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, MELETE_SHOT: file },
        });
        const timer = setTimeout(() => {
          stopTree(child.pid);
          resolve(false);
        }, LIMITS.screenshot_timeout_ms);
        child.once('error', () => {
          clearTimeout(timer);
          resolve(false);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          resolve(code === 0);
        });
      });
      if (ok && (await stat(file).catch(() => null))?.isFile()) return await readFile(file);
    }
    throw new Refusal('failed', 'No screenshot tool worked on this computer.');
  } finally {
    await rm(file, { force: true });
  }
}

export async function runTool(
  tool: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<Record<string, unknown>> {
  checkCapability(tool, context.capabilities);
  switch (tool) {
    case 'list_files': {
      const target = await resolveInside(args.path, context.folders);
      const info = await lstat(target).catch(() => null);
      if (!info?.isDirectory()) throw new Refusal('not_found', 'No such folder.');
      const names = (await readdir(target)).sort();
      const entries: { name: string; kind: 'file' | 'directory' | 'other'; size?: number }[] = [];
      for (const name of names.slice(0, LIMITS.max_list_entries)) {
        const entry = await lstat(join(target, name)).catch(() => null);
        if (!entry) continue;
        entries.push(
          entry.isSymbolicLink()
            ? { name, kind: 'other' }
            : entry.isDirectory()
              ? { name, kind: 'directory' }
              : entry.isFile()
                ? { name, kind: 'file', size: entry.size }
                : { name, kind: 'other' },
        );
      }
      return { entries, truncated: names.length > LIMITS.max_list_entries };
    }
    case 'read_file': {
      const target = await resolveInside(args.path, context.folders);
      let content: Buffer;
      try {
        content = await readCapped(target);
      } catch (error) {
        if (error instanceof Refusal) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') throw new Refusal('not_found', 'No such file.');
        if (code === 'ELOOP') throw new Refusal('outside_folders', 'Links are not followed.');
        throw error;
      }
      const { text, binary } = asText(content);
      return { content: text, bytes: content.byteLength, binary, content_hash: digest(content) };
    }
    case 'write_file': {
      if (typeof args.content !== 'string')
        throw new Refusal('invalid_request', 'The content to write is required.');
      const bytes = Buffer.from(args.content, 'utf8');
      if (bytes.byteLength > LIMITS.max_file_bytes)
        throw new Refusal('too_large', 'That is more than 1 MB.');
      if (parsePath(args.path, context.folders).segments.length === 0)
        throw new Refusal('invalid_request', 'Name a file inside the shared folder.');
      const target = await resolveInside(args.path, context.folders, { createParents: true });
      const file = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | NOFOLLOW,
        0o600,
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ELOOP') throw new Refusal('outside_folders', 'Links are not followed.');
        if (error.code === 'EISDIR') throw new Refusal('invalid_request', 'That is a folder.');
        throw error;
      });
      try {
        const info = await file.stat();
        if (!info.isFile()) throw new Refusal('invalid_request', 'That is not a regular file.');
        // Checked on the open file, before anything in it changes.
        refuseHardLink(info);
        await file.truncate(0);
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      const written = await readCapped(target);
      return { bytes: written.byteLength, content_hash: digest(written) };
    }
    case 'run': {
      if (typeof args.command !== 'string' || !args.command.trim())
        throw new Refusal('invalid_request', 'A command is required.');
      const asked = args.timeout_ms;
      const timeoutMs =
        typeof asked === 'number' && Number.isInteger(asked)
          ? Math.min(Math.max(asked, 100), LIMITS.max_command_timeout_ms)
          : LIMITS.default_command_timeout_ms;
      let cwd = homedir();
      if (args.cwd !== undefined) {
        cwd = await resolveInside(args.cwd, context.folders);
        if (!(await lstat(cwd).catch(() => null))?.isDirectory())
          throw new Refusal('not_found', 'No such folder to run in.');
      }
      return runCommand({ command: args.command, cwd, timeoutMs });
    }
    case 'open_url': {
      const url = checkUrl(args.url);
      // The service marks an address the person approved. Anything else on
      // this computer or its network, by name or by what it resolves to here,
      // is refused rather than opened with the person's browser and cookies.
      if (args.local_approved !== true && (await onLocalNetwork(new URL(url), context.resolve)))
        throw new Refusal(
          'invalid_request',
          'That address is on this computer or its local network, so it opens only once the person approves it.',
        );
      const [command, commandArgs] = openCommand(url);
      await (context.launch ?? launchDefault)(command, commandArgs);
      return { opened: true };
    }
    case 'screenshot': {
      const image = await (context.captureScreen ?? captureDefault)();
      if (image.byteLength > LIMITS.max_screenshot_bytes)
        throw new Refusal('too_large', 'The screenshot is larger than the cap.');
      return { png_base64: image.toString('base64') };
    }
    default:
      throw new Refusal('invalid_request', `Unknown request: ${tool}`);
  }
}
