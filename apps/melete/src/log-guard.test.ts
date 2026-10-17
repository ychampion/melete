import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { redactLogLine } from './log-guard.ts';

describe('redactLogLine', () => {
  test('takes out the shapes that are always secret', () => {
    const session = 'Q2xhdWRlU2Vzc2lvblRva2VuMDEyMzQ1Njc4OWFiY2Rl';
    const cases: [string, string][] = [
      ['connect postgres://melete:hunter2@db:5432/melete', 'postgres://[redacted]@db:5432/melete'],
      ['header Authorization: Bearer abcdefgh12345678', 'Bearer [redacted]'],
      ['key sk-ant-api03-abcdefghijklmnop refused', 'key [redacted] refused'],
      ['key ghp_abcdefghijklmnopqrstuvwxyz0123 refused', 'key [redacted] refused'],
      ['token mdt_abcdefghijklmnopqrstuvwxyz refused', '[redacted] refused'],
      ['jwt eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl here', 'jwt [redacted] here'],
      ['password=hunter2 sent', 'password=[redacted] sent'],
      [`session ${session} expired`, 'session [redacted] expired'],
      ['mail to someone@example.com failed', 'mail to [email] failed'],
      [
        'key -----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY----- read',
        'key [redacted] read',
      ],
    ];
    for (const [line, expected] of cases) {
      const out = redactLogLine(line);
      expect(out).toContain(expected);
      expect(out).not.toContain('hunter2');
    }
  });

  test('keeps the ids, digests and counts an operator reads a log by', () => {
    const lines = [
      'attempt att_01JB2X7Q9V3M5N8K4R6T0W2Y1Z failed (timed out)',
      'container 4f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c stopped',
      'blob sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 kept',
      'usage tokens: 512 for job 3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
      'melete 0.2.1 listening on 0.0.0.0:8080',
    ];
    for (const line of lines) expect(redactLogLine(line)).toBe(line);
  });

  test('takes linear time on a long line', () => {
    // Each of these once took seconds at this length, holding the whole process.
    for (const unit of ['a', 'a.', 'a-', 'ab+', 'sk-', 'eyJ-', 'session-', 'a@b']) {
      const line = unit.repeat(Math.ceil(100_000 / unit.length));
      const started = performance.now();
      redactLogLine(line);
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  }, 120_000);
});

describe('guardProcessLogs', () => {
  test('redacts console output and direct writes in the guarded process', async () => {
    const guard = join(import.meta.dir, 'log-guard.ts').replaceAll('\\', '/');
    const script = [
      `const { guardProcessLogs } = await import(${JSON.stringify(guard)});`,
      'guardProcessLogs();',
      "console.error('failed for', { url: 'https://u:hunter2@example.org/x' });",
      "console.log('key sk-abcdefghijklmnop0123');",
      "process.stderr.write('password=hunter2\\n');",
      "process.stdout.write(new TextEncoder().encode('Bearer abcdefgh12345678\\n'));",
    ].join('\n');
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(await child.exited).toBe(0);
    const all = `${out}${err}`;
    expect(all).not.toContain('hunter2');
    expect(all).not.toContain('sk-abcdefghijklmnop0123');
    expect(all).not.toContain('abcdefgh12345678');
    expect(err).toContain('failed for');
    expect(err).toContain('[redacted]@example.org');
    expect(out).toContain('key [redacted]');
  });
});
