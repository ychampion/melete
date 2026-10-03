/**
 * GitHub for real, through the relay. Skipped unless
 * `MELETE_EGRESS_LIVE=github`; never part of an ordinary run or of CI.
 *
 *   MELETE_EGRESS_LIVE_GITHUB_TOKEN  a fine-grained token for one throwaway repository,
 *                                    with read and write on Contents and Pull requests
 *   MELETE_EGRESS_LIVE_GITHUB_REPO   that repository, as owner/name; its default branch
 *                                    must exist
 *
 * The machine's own `git` and `gh` play the computer: they hold only the
 * placeholder and the egress CA, and reach GitHub through a relay in this
 * process, which adds the token and brings every change here, where each one
 * is approved. The run clones, pushes a new branch, opens a pull request,
 * closes it, and deletes the branch. Run it on Linux or macOS: gh on Windows
 * reads only the system's certificate store.
 */
import { describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rootCertificates } from 'node:tls';
import { promisify } from 'node:util';
import type { EgressWriteInput } from '../../broker/egress-admission.ts';
import { SandboxEgressGuard } from '../../sandbox/adapters/docker-egress.ts';
import { memoryCredentialPort } from '../fixtures.ts';
import { GITHUB_TOKEN_PLACEHOLDER, githubAdapter } from './github.ts';
import type { CredentialAdapter } from './types.ts';

const live = process.env.MELETE_EGRESS_LIVE === 'github';
const token = process.env.MELETE_EGRESS_LIVE_GITHUB_TOKEN ?? '';
const repo = process.env.MELETE_EGRESS_LIVE_GITHUB_REPO ?? '';

describe.skipIf(!live)('GitHub live, through the relay', () => {
  test('clone, push a branch, open and close a pull request, and delete the branch', async () => {
    expect(token).not.toBe('');
    expect(repo).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    const writes: EgressWriteInput[] = [];
    const port = memoryCredentialPort({
      secret: token,
      account: { adapter: githubAdapter as CredentialAdapter, config: {} },
      // Every change is approved here, as the person would on its card.
      admitWrite: async (input) => {
        writes.push(input);
        return {
          kind: 'sent',
          actionId: `act_live_${writes.length}`,
          result: await input.forward(),
        };
      },
    });
    const guard = new SandboxEgressGuard({ credentials: port });
    const relayPort = await guard.listen(0, '127.0.0.1');
    guard.allow('127.0.0.1', 'live-computer', { mode: 'open', session: 'live', space: 'sp_live' });
    const proxyToken = guard.mint('live-computer', {
      kind: 'command',
      sessionId: 'live',
      jobId: 'job_live',
      attemptId: 'att_live',
      actionId: 'act_live',
      deadlineAt: Date.now() + 600_000,
    });
    const work = await mkdtemp(path.join(tmpdir(), 'melete-github-live-'));
    const bundle = path.join(work, 'bundle.pem');
    await writeFile(bundle, [(await port.ca.certificate()).pem, ...rootCertificates].join('\n'));
    const proxy = `http://cmd:${proxyToken}@127.0.0.1:${relayPort}`;
    const env: Record<string, string | undefined> = {
      ...process.env,
      HTTPS_PROXY: proxy,
      https_proxy: proxy,
      NO_PROXY: '',
      no_proxy: '',
      SSL_CERT_FILE: bundle,
      GIT_SSL_CAINFO: bundle,
      GH_TOKEN: GITHUB_TOKEN_PLACEHOLDER,
      GH_PROMPT_DISABLED: '1',
      GIT_TERMINAL_PROMPT: '0',
      GH_CONFIG_DIR: path.join(work, 'gh'),
      GIT_AUTHOR_NAME: 'Melete live check',
      GIT_AUTHOR_EMAIL: 'live@example.com',
      GIT_COMMITTER_NAME: 'Melete live check',
      GIT_COMMITTER_EMAIL: 'live@example.com',
    };
    delete env.MELETE_EGRESS_LIVE_GITHUB_TOKEN;
    const run = async (command: string, args: string[], cwd = work) => {
      const { stdout, stderr } = await promisify(execFile)(command, args, { cwd, env });
      const printed = `${stdout}${stderr}`;
      expect(printed).not.toContain(token);
      return stdout.trim();
    };
    const branch = `melete/live-${Date.now().toString(36)}`;
    const site = path.join(work, 'site');
    try {
      await run('git', ['clone', '-q', `https://github.com/${repo}`, site]);
      const base = await run('git', ['symbolic-ref', '--short', 'HEAD'], site);
      await run('git', ['checkout', '-q', '-b', branch], site);
      await writeFile(path.join(site, 'melete-live.txt'), `${branch}\n`);
      await run('git', ['add', 'melete-live.txt'], site);
      await run('git', ['commit', '-q', '-m', 'Check pushing through the relay'], site);
      await run('git', ['push', '-q', 'origin', branch], site);
      const url = await run('gh', [
        'pr',
        'create',
        '--repo',
        repo,
        '--head',
        branch,
        '--base',
        base,
        '--title',
        'Check the relay',
        '--body',
        'Opened and closed by the live check.',
      ]);
      expect(url).toMatch(/^https:\/\/github\.com\/.+\/pull\/\d+$/);
      await run('gh', ['pr', 'close', url, '--repo', repo]);
      await run('git', ['push', '-q', 'origin', '--delete', branch], site);
      const kinds = writes.map((input) => [input.write.operation, input.write.summary.title]);
      expect(kinds).toContainEqual(['push', `Push to ${repo} (${branch})`]);
      expect(kinds).toContainEqual(['push', `Delete ${branch} in ${repo}`]);
      expect(kinds.map(([operation]) => operation)).toContain('graphql');
      expect(
        writes.find((input) => input.write.summary.title.startsWith('Delete'))?.write.destructive,
      ).toBe(true);
    } finally {
      await guard.close();
      await rm(work, { recursive: true, force: true });
    }
  }, 300_000);
});
