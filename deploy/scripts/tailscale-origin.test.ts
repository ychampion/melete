import { describe, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import {
  certDomain,
  DEFAULT_NODE_NAME,
  ENV_FILE_MODE,
  type FileReplacer,
  originReport,
  readStatus,
  recreateCommand,
  replaceFile,
  STATUS_COMMAND,
  tailnetOrigin,
  tailscaleNodeName,
  tailscaleNotes,
  withOrigin,
} from './tailscale-origin.ts';

/**
 * `tailscale status --json` from a joined node, with the fields this reads and
 * a few of the ones beside them, so a version that adds keys changes nothing.
 * The certificate domain carries no trailing dot and the node's own name does,
 * which is why the two are normalised together.
 */
const joined = {
  Version: '1.102.3',
  BackendState: 'Running',
  TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::4501'],
  MagicDNSSuffix: 'tail1a2b3.ts.net',
  CertDomains: ['melete.tail1a2b3.ts.net'],
  Self: {
    HostName: 'melete',
    DNSName: 'melete.tail1a2b3.ts.net.',
    Online: true,
  },
};

/** The same node before the control plane has given it a certificate name. */
const starting = {
  Version: '1.102.3',
  BackendState: 'Starting',
  TailscaleIPs: [],
  CertDomains: [],
  Self: { HostName: 'melete', DNSName: '', Online: false },
};

describe('the tailnet origin', () => {
  test('is the certificate domain the node answers HTTPS on', () => {
    expect(certDomain(joined)).toBe('melete.tail1a2b3.ts.net');
    expect(tailnetOrigin('melete.tail1a2b3.ts.net')).toBe('https://melete.tail1a2b3.ts.net');
  });

  test("falls back to the node's own name, without its trailing dot", () => {
    // A tailnet with HTTPS certificates off reports no certificate domain.
    expect(certDomain({ ...joined, CertDomains: [] })).toBe('melete.tail1a2b3.ts.net');
    expect(certDomain({ Self: { DNSName: 'MELETE.Tail1A2B3.TS.NET.' } })).toBe(
      'melete.tail1a2b3.ts.net',
    );
  });

  test('is absent rather than guessed while the node is still joining', () => {
    expect(certDomain(starting)).toBeNull();
    expect(certDomain({})).toBeNull();
  });

  test('is never something that is not a dotted name', () => {
    for (const value of [
      '',
      '.',
      'melete',
      'melete..ts.net',
      '-melete.ts.net',
      'melete.ts.net/login',
      'melete.ts.net:443',
      'https://melete.ts.net',
      '100.101.102.103',
      42,
      null,
    ])
      expect(certDomain({ CertDomains: [value], Self: null }), JSON.stringify(value)).toBeNull();
  });

  test('prefers the certificate domain when the two names differ', () => {
    // Serve terminates TLS only for a certificate domain, so it wins.
    expect(certDomain({ CertDomains: ['cert.ts.net'], Self: { DNSName: 'other.ts.net.' } })).toBe(
      'cert.ts.net',
    );
  });
});

describe('the setting written into deploy/.env', () => {
  const file = [
    '# Ports on the host',
    'WEB_PORT=3101',
    '# Optional HTTPS origin when putting the loopback web service behind a proxy.',
    'MELETE_WEB_ORIGIN=',
    'TS_HOSTNAME=melete',
    '',
  ].join('\n');

  test('replaces the existing line and keeps the comments around it', () => {
    const { text, changed } = withOrigin(file, 'https://melete.tail1a2b3.ts.net');
    expect(changed).toBe(true);
    expect(text.split('\n')).toEqual([
      '# Ports on the host',
      'WEB_PORT=3101',
      '# Optional HTTPS origin when putting the loopback web service behind a proxy.',
      'MELETE_WEB_ORIGIN=https://melete.tail1a2b3.ts.net',
      'TS_HOSTNAME=melete',
      '',
    ]);
  });

  test('changes nothing when the origin already stands', () => {
    const once = withOrigin(file, 'https://melete.tail1a2b3.ts.net');
    const twice = withOrigin(once.text, 'https://melete.tail1a2b3.ts.net');
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once.text);
  });

  test('replaces an exported or padded form rather than adding a second line', () => {
    for (const line of ['export MELETE_WEB_ORIGIN=old', '  MELETE_WEB_ORIGIN = old ']) {
      const { text } = withOrigin(`A=1\n${line}\nB=2\n`, 'https://melete.ts.net');
      expect(text, line).toBe('A=1\nMELETE_WEB_ORIGIN=https://melete.ts.net\nB=2\n');
    }
  });

  test('is appended to a file that never had the setting', () => {
    expect(withOrigin('A=1\n', 'https://melete.ts.net').text).toBe(
      'A=1\nMELETE_WEB_ORIGIN=https://melete.ts.net\n',
    );
    // A file whose last line has no newline still gets its own line.
    expect(withOrigin('A=1', 'https://melete.ts.net').text).toBe(
      'A=1\nMELETE_WEB_ORIGIN=https://melete.ts.net\n',
    );
  });

  test('never matches a setting that merely ends with the name', () => {
    const { text } = withOrigin('OTHER_MELETE_WEB_ORIGIN=keep\n', 'https://melete.ts.net');
    expect(text).toBe('OTHER_MELETE_WEB_ORIGIN=keep\nMELETE_WEB_ORIGIN=https://melete.ts.net\n');
  });
});

describe('what the run reports', () => {
  test('the origin, the file it wrote and the one command that applies it', () => {
    const report = originReport(joined, 'MELETE_WEB_ORIGIN=\n');
    expect(report.found).toBe(true);
    expect(report.lines[0]).toBe('MELETE_WEB_ORIGIN=https://melete.tail1a2b3.ts.net');
    expect(report.lines[1]).toContain(recreateCommand());
    expect(report.text).toBe('MELETE_WEB_ORIGIN=https://melete.tail1a2b3.ts.net\n');
  });

  test('the applying command names both compose files and recreates only the web service', () => {
    expect(recreateCommand()).toBe(
      'docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.tailscale.yml up -d --no-deps --force-recreate web',
    );
    // Only the web service. Without --no-deps the command also brings up what
    // web depends on, built from the two files named here, so an installation
    // running a further override would have its other services recreated
    // without that override. A line printed to apply one setting may not do
    // that, and the reader cannot be expected to notice.
    expect(recreateCommand()).toContain('--no-deps');
  });

  test('nothing to write, and nothing to restart, on a second run', () => {
    const report = originReport(joined, 'MELETE_WEB_ORIGIN=https://melete.tail1a2b3.ts.net\n');
    expect(report.found).toBe(true);
    expect(report.text).toBeUndefined();
    expect(report.lines[1]).toContain('needs nothing');
  });

  test('why there is no origin yet, and never a half-written file', () => {
    const report = originReport(starting, 'MELETE_WEB_ORIGIN=\n');
    expect(report.found).toBe(false);
    expect(report.text).toBeUndefined();
    expect(report.lines.join(' ')).toContain('HTTPS certificates');
    expect(report.lines.join(' ')).toContain('Starting');
  });
});

describe('the node name configure.ts settles', () => {
  test('is absent unless the tailnet settings were asked for', () => {
    expect(tailscaleNodeName(['bun', 'configure.ts'])).toBeNull();
    expect(tailscaleNodeName(['bun', 'configure.ts', '--fake'])).toBeNull();
  });

  test('defaults to the name the overlay and the documentation use', () => {
    expect(tailscaleNodeName(['--tailscale'])).toBe(DEFAULT_NODE_NAME);
    expect(DEFAULT_NODE_NAME).toBe('melete');
  });

  test('is the given name, beside the other flags, in either order', () => {
    expect(tailscaleNodeName(['--tailscale', '--tailscale-hostname', 'desk'])).toBe('desk');
    expect(tailscaleNodeName(['--tailscale-hostname', 'desk-2', '--tailscale', '--fake'])).toBe(
      'desk-2',
    );
  });

  test('is refused rather than trimmed into a different address', () => {
    for (const name of ['', 'Melete', 'melete.ts.net', '-melete', 'melete_1', 'a'.repeat(64)])
      expect(
        () => tailscaleNodeName(['--tailscale', '--tailscale-hostname', name]),
        JSON.stringify(name),
      ).toThrow('is not a node name');
  });

  test('names a hostname flag that would otherwise be silently ignored', () => {
    expect(() => tailscaleNodeName(['--tailscale-hostname', 'desk'])).toThrow('needs --tailscale');
  });

  test('what is printed afterwards names the key to paste and the origin script', () => {
    const notes = tailscaleNotes('desk').join('\n');
    expect(notes).toContain('TS_HOSTNAME=desk');
    expect(notes).toContain('TS_AUTHKEY left empty');
    expect(notes).toContain('deploy/scripts/tailscale-origin.ts');
    expect(notes).toContain('MELETE_WEB_ORIGIN');
    // The key is never echoed, so nothing here can carry one.
    expect(notes).not.toMatch(/tskey-/i);
  });
});

describe('writing deploy/.env back', () => {
  const PATH = 'deploy/.env';
  /** The file this replaces holds the key that decrypts the installation. */
  const ORIGINAL = ['MELETE_MASTER_KEY=kept', 'MELETE_WEB_ORIGIN=', ''].join('\n');
  const NEXT = ['MELETE_MASTER_KEY=kept', 'MELETE_WEB_ORIGIN=https://melete.ts.net', ''].join('\n');

  /**
   * A writer and a renamer over a map of paths, so the order of the two and
   * what stood at each path in between are both visible to the test.
   */
  function disk(options: { failWrite?: boolean; failRename?: boolean } = {}) {
    const files: Record<string, string> = { [PATH]: ORIGINAL };
    const attempted: { path: string; mode: number }[] = [];
    const renamed: [string, string][] = [];
    const removed: string[] = [];
    let atRename: { original: string | undefined; temporary: string | undefined } | null = null;
    const replacer: FileReplacer = {
      write: async (path, text, mode) => {
        attempted.push({ path, mode });
        if (options.failWrite) throw new Error('no space left on device');
        files[path] = text;
      },
      rename: async (from, to) => {
        atRename = { original: files[to], temporary: files[from] };
        if (options.failRename) throw new Error('rename refused');
        renamed.push([from, to]);
        files[to] = files[from] ?? '';
        delete files[from];
      },
      remove: async (path) => {
        removed.push(path);
        delete files[path];
      },
    };
    return {
      replacer,
      files,
      attempted,
      renamed,
      removed,
      rename: () => atRename as { original?: string; temporary?: string } | null,
      /** The one temporary the run asked to write, whether the write succeeded or not. */
      temporary: () => {
        const [first] = attempted;
        if (first === undefined) throw new Error('the run wrote nothing');
        return first;
      },
    };
  }

  test('leaves the original whole until the rename puts the new text in its place', async () => {
    const it = disk();
    await replaceFile(PATH, NEXT, it.replacer);
    // The rename is what changes the file: until it runs the original still
    // reads as it did, so an interrupted run cannot leave an empty deploy/.env.
    expect(it.rename()?.original).toBe(ORIGINAL);
    expect(it.rename()?.temporary).toBe(NEXT);
    expect(it.renamed).toEqual([[it.temporary().path, PATH]]);
    expect(it.files[PATH]).toBe(NEXT);
  });

  test('writes the temporary beside the original, with the same mode', async () => {
    const it = disk();
    await replaceFile(PATH, NEXT, it.replacer);
    expect(it.attempted).toHaveLength(1);
    const temporary = it.temporary().path;
    // Same directory, or the rename would cross a filesystem and not be one
    // step; the mode is the file's, so the key is never briefly readable.
    expect(dirname(temporary)).toBe(dirname(PATH));
    expect(temporary).not.toBe(PATH);
    expect(it.temporary().mode).toBe(ENV_FILE_MODE);
    expect(ENV_FILE_MODE).toBe(0o600);
    expect(it.files[temporary]).toBeUndefined();
  });

  test('a failed write leaves the original intact and renames nothing', async () => {
    const it = disk({ failWrite: true });
    await expect(replaceFile(PATH, NEXT, it.replacer)).rejects.toThrow('no space left on device');
    expect(it.files[PATH]).toBe(ORIGINAL);
    expect(it.renamed).toEqual([]);
    expect(it.removed).toEqual([it.temporary().path]);
  });

  test('a failed rename leaves the original intact and clears the temporary', async () => {
    const it = disk({ failRename: true });
    await expect(replaceFile(PATH, NEXT, it.replacer)).rejects.toThrow('rename refused');
    expect(it.files[PATH]).toBe(ORIGINAL);
    expect(it.removed).toEqual([it.temporary().path]);
    expect(it.files[it.temporary().path]).toBeUndefined();
  });

  test('two runs at once do not write to the one temporary path', async () => {
    const it = disk();
    await replaceFile(PATH, NEXT, it.replacer);
    await replaceFile(PATH, NEXT, it.replacer);
    expect(new Set(it.attempted.map((write) => write.path)).size).toBe(2);
  });
});

describe('asking the node', () => {
  test('runs tailscale status inside the node, through both compose files', async () => {
    const asked: string[][] = [];
    const status = await readStatus(async (command) => {
      asked.push([...command]);
      return { code: 0, stdout: JSON.stringify(joined), stderr: '' };
    });
    expect(asked).toEqual([[...STATUS_COMMAND]]);
    expect(certDomain(status)).toBe('melete.tail1a2b3.ts.net');
    // No shell, and the node is addressed by service name, not by container id.
    expect(STATUS_COMMAND).toContain('deploy/docker-compose.tailscale.yml');
    expect(STATUS_COMMAND.slice(-5)).toEqual(['-T', 'tailscale', 'tailscale', 'status', '--json']);
  });

  test('says the overlay is not running rather than reporting a missing domain', async () => {
    const failing = readStatus(async () => ({
      code: 1,
      stdout: '',
      stderr: 'no such service: tailscale',
    }));
    await expect(failing).rejects.toThrow('Start the overlay first');
  });

  test('says the answer was not status rather than crashing on it', async () => {
    const failing = readStatus(async () => ({ code: 0, stdout: 'not json', stderr: '' }));
    await expect(failing).rejects.toThrow('did not answer with JSON');
  });
});
