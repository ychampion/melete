/**
 * What the model is actually told, read off the request the pinned engine sends.
 *
 * The service is booted with the process supervisor, so the real engine builds
 * its own system prompt from the configuration and home Melete renders. The
 * scripted provider records every request body, and the first message of the
 * first request is the system prompt the model saw.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentResponse, conversationResponse } from '@melete/contracts';
import { loadIdentity } from '@melete/skills';
import { loadEnv } from '../../src/env.ts';
import { AGENT_TEMPLATES } from '../../src/experience/agents.ts';
import { createScriptedProvider } from '../../src/gateway/fake.ts';
import { bootstrap } from '../../src/index.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const configured = loadEnv({});
const localEngine = existsSync(configured.MELETE_HERMES_PYTHON);
if (!localEngine)
  process.stdout.write(
    'identity prompt skipped: .hermes-venv is absent; install the pinned local Hermes first\n',
  );
const handle = localEngine ? await testDatabase() : null;
afterAll(async () => {
  await handle?.close();
}, 30_000);

/** A zone that is not this machine's, so the prompt can only have it from the profile. */
const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const profileZone = hostZone === 'Pacific/Chatham' ? 'Pacific/Kiritimati' : 'Pacific/Chatham';
/** How the engine names the host's zone when it has none of its own, e.g. "India Standard Time". */
const hostZoneName =
  new Intl.DateTimeFormat('en-US', { timeZoneName: 'long' })
    .formatToParts(new Date())
    .find((part) => part.type === 'timeZoneName')?.value ?? hostZone;

type Body = { messages?: { role: string; content: unknown }[] };
const text = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part as { text?: string }).text ?? '').join('')
      : '';

(handle ? describe : describe.skip)('the system prompt the pinned engine sends', () => {
  test('a chat is Melete first, with its persona on top and only this attempt’s facts', async () => {
    if (!handle) return;
    await resetTestRows(handle.sql);
    const root = await mkdtemp(join(tmpdir(), 'melete-identity-'));
    const requests: Body[] = [];
    const scripted = createScriptedProvider([{ text: 'I am Nova, and Melete keeps my notes.' }]);
    const service = await bootstrap({
      env: loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: handle.url,
        MELETE_RUNTIME_ADAPTER: 'hermes',
        MELETE_RUNTIME_SUPERVISOR: 'process',
        MELETE_CAPABILITY_KEY: 'identity-capability-key-32-characters',
        MELETE_APPROVAL_KEY: 'identity-approval-key-32-characters-x',
        MELETE_SPACES_DIR: join(root, 'spaces'),
        MELETE_WORK_DIR: join(root, 'work'),
        MELETE_BROKER_BIND: '127.0.0.1:3182',
        MELETE_BROKER_URL: 'http://127.0.0.1:3182',
        MELETE_ENABLE_FAKE_PROVIDER: 'true',
        MELETE_DEFAULT_PROVIDER: 'fake',
        MELETE_DEFAULT_MODEL: 'scripted',
      }),
      fakeProvider: async (body, attemptId, protocol) => {
        requests.push(body as Body);
        return scripted(body, attemptId, protocol);
      },
    });
    let cookie = '';
    const call = async (path: string, method = 'GET', body?: unknown) =>
      service.app.request(path, {
        method,
        headers: { 'content-type': 'application/json', cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      const setup = await call('/setup', 'POST', {
        email: 'identity@example.test',
        password: 'identity-local-password',
      });
      expect(setup.status).toBe(201);
      cookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';
      expect(
        (
          await call('/profile', 'PATCH', {
            name: 'Alex',
            time_zone: profileZone,
            day_hours: { start: '00:00', end: '00:00' },
          })
        ).status,
      ).toBe(200);
      const template = AGENT_TEMPLATES.templates[0]?.agent;
      if (!template) throw new Error('No agent template');
      const persona = agentResponse.parse(
        await (await call('/agents', 'POST', template)).json(),
      ).agent;
      const chat = conversationResponse.parse(
        await (await call('/conversations', 'POST', { title: 'Who', agent_id: persona.id })).json(),
      ).conversation;
      expect(
        (await call(`/conversations/${chat.id}/messages`, 'POST', { text: 'who are you?' })).status,
      ).toBeLessThan(300);

      const deadline = Date.now() + 90_000;
      while (requests.length === 0 && Date.now() < deadline) await Bun.sleep(100);
      const [first] = requests;
      if (!first?.messages) throw new Error('The engine sent no request within 90 seconds');
      const [system] = first.messages;
      const prompt = text(system?.content);
      if (process.env.MELETE_IDENTITY_PROMPT_DUMP)
        await writeFile(process.env.MELETE_IDENTITY_PROMPT_DUMP, prompt);

      expect(system?.role).toBe('system');
      const identity = loadIdentity();
      // Melete comes first, whole: the voice rules are not paraphrased away.
      expect(prompt.startsWith(identity)).toBe(true);
      // The persona sits on top of the identity, never in place of it.
      const speaking = `In this conversation you are ${template.name}`;
      expect(prompt).toContain(speaking);
      expect(prompt).toContain(template.standing_instruction);
      expect(prompt.indexOf(speaking)).toBeGreaterThan(identity.length);
      // The engine's own persona and its product pointers never reach the model.
      for (const stock of ['Hermes Agent', 'Nous Research', 'nousresearch.com'])
        expect(prompt).not.toContain(stock);
      // The person's zone, not this machine's.
      expect(prompt).toContain(profileZone);
      expect(prompt).not.toContain(hostZone);
      expect(prompt).not.toContain(hostZoneName);
      // Host details that are not true for the attempt: no terminal is offered,
      // no media path convention applies, and neither the engine's home nor the
      // job's working directory on this machine is the person's business.
      for (const host of [
        'MEDIA:',
        'PowerShell',
        'cmd.exe',
        'Python toolchain',
        'Active Hermes profile',
        '# Hermes runtime environment',
        'melete-runtime-',
        root,
        root.replaceAll('\\', '/'),
      ])
        expect(prompt).not.toContain(host);
      // The question reached the model as the person's message.
      expect(JSON.stringify(first.messages.slice(1))).toContain('who are you?');
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }, 150_000);
});
