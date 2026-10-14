import { describe, expect, test } from 'bun:test';
import { runDoctor } from './commands/doctor.ts';
import type { Run } from './context.ts';
import { judgeLeftovers, readSandboxLeftovers, removeLeftovers } from './sandbox-leftovers.ts';
import { reportSchema } from './schema.ts';
import { temporaryDeployDir, testContext, writeEnv } from './testing.ts';

/**
 * An engine with two installations: `melete` on sandbox project melete-aaaa1111
 * and `melete2` (stopped) on melete-bbbb2222, and computers and networks of
 * those and of two projects nobody uses any more.
 */
function engine(options: { refuse?: string[] } = {}) {
  const calls: string[] = [];
  const removed: string[] = [];
  const run: Run = (command) => {
    const line = command.join(' ');
    calls.push(line);
    const answer = (stdout: string) => ({ code: 0, stdout, stderr: '' });
    if (line === 'docker ps --all --quiet --filter label=com.docker.compose.service=melete')
      return answer('aaa111\nbbb222\n');
    if (line.startsWith('docker inspect --format {{range .Config.Env}}'))
      return answer(
        'MELETE_SANDBOX_PROJECT=melete-aaaa1111\nMELETE_SANDBOX_PROJECT=melete-bbbb2222\n',
      );
    if (line.startsWith('docker ps --all --filter label=com.melete.sandbox=v1 --format'))
      return answer(
        [
          'c1\tmelete-sbx-melete-aaaa1111-a\texited\tmelete-aaaa1111',
          'c2\tmelete-sbx-melete-bbbb2222-b\texited\tmelete-bbbb2222',
          'c3\tmelete-sbx-melete-cccc3333-c\texited\tmelete-cccc3333',
          'c4\tmelete-sbx-melete-cccc3333-d\trunning\tmelete-cccc3333',
          'c5\tmelete-sbx-melete-dddd4444-e\tcreated\tmelete-dddd4444',
          'c6\tsomething-else\texited\t',
        ].join('\n'),
      );
    if (line === 'docker network ls --quiet --filter label=com.melete.sandbox=v1')
      return answer('aa01aa01aa01\nbb02bb02bb02\ncc03cc03cc03\ncc04cc04cc04\n');
    if (line.startsWith('docker network inspect --format {{.Name}}'))
      return answer(
        [
          'melete-sbx-melete-aaaa1111-a-net\tmelete-aaaa1111\t0',
          'melete-sbx-melete-bbbb2222-b-net\tmelete-bbbb2222\t0',
          'melete-sbx-melete-cccc3333-c-net\tmelete-cccc3333\t0',
          'melete-sbx-melete-cccc3333-d-net\tmelete-cccc3333\t1',
        ].join('\n'),
      );
    if (line.startsWith('docker rm ') || line.startsWith('docker network rm ')) {
      const target = command.at(-1) ?? '';
      if (options.refuse?.includes(target)) return { code: 1, stdout: '', stderr: 'in use' };
      removed.push(target);
      return answer(`${target}\n`);
    }
    return { code: 1, stdout: '', stderr: 'no such command in this test' };
  };
  return { run, calls, removed };
}

describe("agents' computers no installation uses", () => {
  test('only stopped computers and empty networks of projects nobody runs with are listed', () => {
    const leftovers = readSandboxLeftovers(engine().run, null);
    expect(leftovers).toEqual([
      {
        project: 'melete-cccc3333',
        containers: [
          {
            id: 'c3',
            name: 'melete-sbx-melete-cccc3333-c',
            state: 'exited',
            project: 'melete-cccc3333',
          },
        ],
        networks: [
          { name: 'melete-sbx-melete-cccc3333-c-net', project: 'melete-cccc3333', containers: 0 },
        ],
      },
      {
        project: 'melete-dddd4444',
        containers: [
          {
            id: 'c5',
            name: 'melete-sbx-melete-dddd4444-e',
            state: 'created',
            project: 'melete-dddd4444',
          },
        ],
        networks: [],
      },
    ]);
  });

  test("this installation's own project is never a leftover, even with its service down", () => {
    const leftovers = readSandboxLeftovers(engine().run, 'melete-cccc3333');
    expect(leftovers?.map((each) => each.project)).toEqual(['melete-dddd4444']);
  });

  test('the rule names each project and what it left, and offers the flag', () => {
    const result = judgeLeftovers(readSandboxLeftovers(engine().run, null));
    expect(result).toMatchObject({ id: 'docker.leftover_sandboxes', level: 'warn' });
    expect(result.detail).toContain(
      'melete-cccc3333 (1 stopped computer, 1 empty network); melete-dddd4444 (1 stopped computer)',
    );
    expect(result.fix).toContain('bun run melete doctor --remove-leftovers');
    expect(judgeLeftovers([]).level).toBe('ok');
    expect(judgeLeftovers(null).level).toBe('warn');
  });

  test('an engine that does not answer lists nothing rather than guessing', () => {
    expect(readSandboxLeftovers(() => ({ code: 1, stdout: '', stderr: '' }), null)).toBeNull();
  });

  test('removal goes without force, and what the engine keeps is said', () => {
    const fake = engine({ refuse: ['melete-sbx-melete-cccc3333-c-net'] });
    const leftovers = readSandboxLeftovers(fake.run, null) ?? [];
    const result = removeLeftovers(fake.run, leftovers);
    expect(fake.removed).toEqual(['c3', 'c5']);
    expect(fake.calls.filter((line) => / rm /.test(line))).toEqual([
      'docker rm c3',
      'docker network rm melete-sbx-melete-cccc3333-c-net',
      'docker rm c5',
    ]);
    expect(result.level).toBe('warn');
    expect(result.detail).toContain('The engine kept melete-sbx-melete-cccc3333-c-net');
  });
});

describe('melete doctor and leftovers', () => {
  const doctorWith = (fake: ReturnType<typeof engine>) => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { MELETE_SANDBOX_PROJECT: 'melete-aaaa1111' });
    const context = testContext(deployDir);
    const fallback = context.run;
    context.run = (command) => {
      const answer = fake.run(command);
      return answer.code === 0 || / rm /.test(command.join(' ')) ? answer : fallback(command);
    };
    return context;
  };

  test('plain doctor only lists them; it removes nothing', async () => {
    const fake = engine();
    const context = doctorWith(fake);
    await runDoctor(context, true, true);
    const value = reportSchema.parse(JSON.parse(context.printed()));
    expect(value.results.find((r) => r.id === 'docker.leftover_sandboxes')?.level).toBe('warn');
    expect(fake.removed).toEqual([]);
  });

  test('--remove-leftovers removes exactly what was listed', async () => {
    const fake = engine();
    const context = doctorWith(fake);
    await runDoctor(context, true, true, true);
    expect(fake.removed).toEqual(['c3', 'melete-sbx-melete-cccc3333-c-net', 'c5']);
    const value = reportSchema.parse(JSON.parse(context.printed()));
    expect(value.results.find((r) => r.id === 'docker.leftover_sandboxes')).toMatchObject({
      level: 'ok',
      detail: expect.stringContaining('Removed'),
    });
  });
});
