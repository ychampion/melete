import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  invalidUtf8,
  pathViolation,
  releasing,
  report,
  scanText,
  scrub,
  violation,
} from './scrub-check.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
/** Any tracked path that is neither this file nor the check itself. */
const source = 'apps/melete/src/broker/authority.ts';

describe('the tracked tree', () => {
  test('carries no local path, session phrase or work code', async () => {
    const { findings } = await scrub(root);
    expect(findings.map((finding) => `${finding.rule} ${finding.file}:${finding.line}`)).toEqual(
      [],
    );
  });

  test('the check and its test may spell the patterns out', () => {
    expect(violation('scripts/scrub-check.ts', 'C:/Users/someone, W1')).toBeNull();
    expect(violation('scripts/scrub-check.test.ts', 'C:/Users/someone, W1')).toBeNull();
  });
});

describe('the check refuses an internal work code', () => {
  test('a work code named in a comment', () => {
    expect(violation(source, '/** W1 supplies owner authentication. */')).toBe('work code');
    expect(violation(source, '// Candidate evaluation belongs to W11.')).toBe('work code');
  });

  test('a trailing letter, and both cases the codes were written in', () => {
    expect(violation(source, 'the W10a executor')).toBe('work code');
    expect(violation(source, 'W16d owns this')).toBe('work code');
    expect(violation(source, "mkdtemp(join(tmpdir(), 'melete-w15-wired-'))")).toBe('work code');
  });

  test('a code buried in a queue name, a key or an address', () => {
    expect(violation(source, "await boss.createQueue('w7.probe');")).toBe('work code');
    expect(violation(source, "key: 'w15-handoff-key-32-characters-long',")).toBe('work code');
    expect(violation(source, "email: 'w6@example.test',")).toBe('work code');
  });

  test('a code joined to a name by an underscore', () => {
    expect(violation(source, 'const n = `melete_w14_upgrade_${x}`;')).toBe('work code');
    expect(violation(source, 'process.env.W7_FAULT_DATABASE_URL')).toBe('work code');
    expect(violation(source, 'const name = `w7_${id}`;')).toBe('work code');
    expect(pathViolation('apps/melete/test/fixtures/w7_fixture.json')).toBe('work code');
  });

  test('an ignore rule, which every contributor reads first', () => {
    expect(violation('.gitignore', '.agents/w2-tests.log')).toBe('work code');
    expect(violation('.gitignore', '.agents/w10b-measurements.json')).toBe('work code');
    expect(violation('.gitignore', '.agents/*.log')).toBeNull();
  });

  test('a numbered decision note keeps the codes in its prose', () => {
    const note = '.agents/notes/0021-hermes-capability-audit.md';
    expect(violation(note, 'After W14 the observer patch additionally reports')).toBeNull();
    expect(violation('.agents/notes/README.md', 'W1 landed first')).toBeNull();
    expect(violation(source, '# W1 service delivery')).toBe('work code');
  });

  test('a working transcript filed under the notes does not', () => {
    // `proposed/` and `reports/` are gone from the tree; the rule still reaches
    // them, so restoring one would fail the build rather than slip back in.
    expect(violation('.agents/notes/reports/w1-service.md', '# W1 service delivery')).toBe(
      'work code',
    );
    expect(
      violation('.agents/notes/proposed/2026-09-12-w11-contract-additions.md', 'W11 adds this'),
    ).toBe('work code');
  });
});

describe('the check refuses a name, not only a line', () => {
  test('a file whose every line is clean but whose name is not', () => {
    const named = '.agents/notes/proposed/2026-09-12-w10a-fix-contract-additions.md';
    expect(pathViolation(named)).toBe('work code');
    expect(scanText(named, 'This file says nothing that must be scrubbed.\n')).toEqual([]);
  });

  test('a name is checked wherever it sits, including a binary one', () => {
    expect(pathViolation('.agents/reports/w2-broker.md')).toBe('work code');
    expect(pathViolation('docs/media/w10b-timings.png')).toBe('work code');
    expect(pathViolation('apps/melete/test/fixtures/melete-oss-scratch.json')).toBe(
      'session trace',
    );
  });

  test('a numbered note gets no exemption for its own name', () => {
    // The prose is a record; the name is a choice made when the file is created.
    expect(pathViolation('.agents/notes/0027-w14-capabilities.md')).toBe('work code');
    expect(pathViolation('.agents/notes/0021-hermes-capability-audit.md')).toBeNull();
  });

  test('ordinary paths are left alone', () => {
    for (const path of [
      'apps/melete/src/broker/authority.ts',
      'apps/web/docs/screens/approval-walk.png',
      'packages/runtime-hermes/config/config.yaml',
      'deploy/scripts/tailscale-compose-check.ts',
      'scripts/scrub-check.ts',
    ])
      expect(pathViolation(path)).toBeNull();
  });
});

describe('the check leaves ordinary text alone', () => {
  const clean = [
    // Identifiers generated by the evaluation transcripts under evals/results.
    ['a ULID', '"reservation_id": "led_01M2AG28C1RGAAJKJ2BQW3C6GY"'],
    ['another ULID', '"connection_id": "conn_01M2AGTWW3CQASRVW7BFEQ2213"'],
    // A line of PEM, taken from a TLS test key the repository used to carry.
    ['base64', 'Um9kOZBERenJfL9aCSW1DzyAp/vNtJ5AGtSFgawKzOcOQzlpK7o3Ld4W0ShblE9z'],
    ['a standards body', 'The W3C trace-context header is not parsed here.'],
    ['a standards link', 'See https://www.w3.org/TR/trace-context/ for the format.'],
    ['a file mode', 'await fs.mkdir(p, { mode: 0o2770 });'],
    ['a longer number', 'const port = W1234;'],
    ['a bare letter', '| column | W | 1 |'],
  ] as const;

  for (const [name, line] of clean)
    test(name, () => {
      expect(violation(source, line)).toBeNull();
    });
});

describe('a release refuses the placeholder link', () => {
  const link = '**[Try it on one email](TRYIT_URL)**';

  test('only when a release is being checked', () => {
    expect(violation('README.md', link)).toBeNull();
    expect(violation('README.md', link, true)).toBe('release placeholder');
    expect(
      violation('README.md', '**[Try it on one email](https://example.test/)**', true),
    ).toBeNull();
  });

  test('MELETE_RELEASE=1 selects it, and nothing else does', () => {
    expect(releasing({ MELETE_RELEASE: '1' })).toBe(true);
    for (const value of [undefined, '', '0', 'true', 'yes'])
      expect(releasing({ MELETE_RELEASE: value })).toBe(false);
  });

  test('a tracked file carrying it fails the scan, and only for a release', async () => {
    const tree = await mkdtemp(join(tmpdir(), 'melete-release-scan-'));
    try {
      await writeFile(join(tree, 'README.md'), `# Melete\n\n${link}\n`);
      for (const command of [
        ['init', '-q'],
        ['add', 'README.md'],
      ])
        expect(Bun.spawnSync(['git', ...command], { cwd: tree }).exitCode).toBe(0);
      const prefix = `${tree}/`;
      expect((await scrub(prefix)).findings).toEqual([]);
      const { findings } = await scrub(prefix, true);
      expect(findings).toEqual([
        { file: 'README.md', line: 3, text: link, rule: 'release placeholder' },
      ]);
      expect(report(findings)).toContain('live address');
    } finally {
      await rm(tree, { recursive: true, force: true });
    }
  });
});

describe('a text file the linter cannot read is refused', () => {
  const bytes = (...values: number[]) => new Uint8Array(values);
  const utf8 = (text: string) => new TextEncoder().encode(text);

  test('valid UTF-8, including characters outside ASCII, passes', () => {
    expect(invalidUtf8(utf8('plain'))).toBe(-1);
    expect(invalidUtf8(utf8('a dash \u2014, an ellipsis \u2026, an emoji \u{1f600}'))).toBe(-1);
    expect(invalidUtf8(bytes())).toBe(-1);
  });

  test('a stray byte, a cut sequence, an overlong form or a surrogate is found where it sits', () => {
    // 0x85 is the ellipsis a Windows code page writes where UTF-8 has three bytes.
    expect(invalidUtf8(bytes(0x61, 0x3d, 0x85, 0x62))).toBe(2);
    expect(invalidUtf8(bytes(0x61, 0xe2, 0x80))).toBe(1);
    expect(invalidUtf8(bytes(0xc0, 0xaf))).toBe(0);
    expect(invalidUtf8(bytes(0xe0, 0x80, 0xaf))).toBe(0);
    expect(invalidUtf8(bytes(0xf0, 0x80, 0x80, 0xaf))).toBe(0);
    expect(invalidUtf8(bytes(0xed, 0xa0, 0x80))).toBe(0);
    expect(invalidUtf8(bytes(0xf4, 0x90, 0x80, 0x80))).toBe(0);
  });

  test('a tracked file carrying one fails the scan with its line', async () => {
    const tree = await mkdtemp(join(tmpdir(), 'melete-utf8-scan-'));
    try {
      await writeFile(join(tree, 'good.ts'), 'export const dash = "\u2014";\n');
      await writeFile(
        join(tree, 'bad.ts'),
        Buffer.concat([
          Buffer.from('const a = 1;\n// Matrix parameters (`;x='),
          Buffer.from([0x85]),
          Buffer.from('`)\n'),
        ]),
      );
      for (const command of [
        ['init', '-q'],
        ['add', 'good.ts', 'bad.ts'],
      ])
        expect(Bun.spawnSync(['git', ...command], { cwd: tree }).exitCode).toBe(0);
      const { findings } = await scrub(`${tree}/`);
      expect(findings).toEqual([
        { file: 'bad.ts', line: 2, text: 'a byte that is not UTF-8 (0x85)', rule: 'not utf-8' },
      ]);
      expect(report(findings)).toContain('saved as UTF-8');
    } finally {
      await rm(tree, { recursive: true, force: true });
    }
  });
});

describe('the failure tells a contributor what to do', () => {
  test('it names the rule, the line, and what to write instead', () => {
    const findings = scanText(source, ['const ok = true;', '// W2 admits the effect.'].join('\n'));
    expect(findings).toEqual([
      { file: source, line: 2, text: '// W2 admits the effect.', rule: 'work code' },
    ]);
    const text = report(findings);
    expect(text).toContain(`${source}:2`);
    expect(text).toContain('not the item it came from');
  });

  test('guidance is printed once per rule that fired, and only for those', () => {
    const text = report(scanText(source, ['// W2 admits it.', '// W7 stores it.'].join('\n')));
    expect(text.split('\n').filter((line) => line.includes('named a piece of work'))).toHaveLength(
      1,
    );
    expect(text).not.toContain('belongs to one machine');
  });

  test('a name is reported without a line number, and says so', () => {
    const named = '.agents/notes/reports/w7-memory.md';
    const text = report([
      { file: named, line: null, text: 'the file name itself', rule: 'work code' },
    ]);
    expect(text).toContain(`${named}: the file name itself`);
    expect(text).not.toContain(`${named}:null`);
    expect(text).toContain('found 1 problem(s)');
  });
});
