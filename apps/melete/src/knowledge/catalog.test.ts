/**
 * Whether a built-in skill can reach an attempt is decided against the catalog
 * the attempt is really given: the tools its connections grant, built the way
 * the service builds them, plus the broker's own lifecycle wait.
 */
import { describe, expect, test } from 'bun:test';
import type { ConnectorManifest } from '@melete/contracts';
import { loadBuiltInSkills } from '@melete/skills';
import { artifactsManifest } from '../connectors/artifacts.ts';
import { calendarManifest } from '../connectors/calendar.ts';
import { grantedToolCatalog } from '../connectors/catalog.ts';
import { emailManifest } from '../connectors/email.ts';
import { filesManifest } from '../connectors/files.ts';
import { createCapabilityConnector, fakeSpeechAdapter } from '../connectors/tts.ts';
import type { Connector } from '../connectors/types.ts';
import { webManifest } from '../connectors/web.ts';
import { reachableToolNames } from './catalog.ts';

const speech = createCapabilityConnector({
  spacesRoot: 'unused',
  adapter: fakeSpeechAdapter,
  provider: 'fake',
});
/** Mail, a CalDAV calendar and speech, beside the connections every space is given. */
const MANIFESTS: ConnectorManifest[] = [
  filesManifest,
  webManifest,
  artifactsManifest,
  emailManifest,
  calendarManifest,
  speech.manifest,
];
const connections = MANIFESTS.map((manifest, index) => ({
  id: `conn_${index}`,
  provider: manifest.provider,
  scopes: manifest.tools.flatMap((tool) => [tool.name, ...tool.required_scopes]),
}));
const registry = {
  get: (id: string): Connector | undefined => {
    const manifest = MANIFESTS[Number(id.slice('conn_'.length))];
    return manifest === undefined ? undefined : ({ ...speech, manifest } as Connector);
  },
};
/** What the service puts in an attempt's scopes: every grant, and the lifecycle wait. */
const scopes = [...new Set([...connections.flatMap((row) => row.scopes), 'job.wait'])];
const granted = grantedToolCatalog(connections, registry, scopes);

const unreachable = (reachable: Set<string>) =>
  loadBuiltInSkills().skills.flatMap((skill) =>
    skill.frontmatter.tools
      .filter((tool) => !reachable.has(tool))
      .map((tool) => `${skill.frontmatter.name}: ${tool}`),
  );

describe('a production attempt reaches every built-in skill', () => {
  test('with mail, a calendar and speech connected, every built-in and playbook is usable', () => {
    expect(unreachable(reachableToolNames(granted, scopes))).toEqual([]);
  });

  test('the lifecycle wait counts only when the attempt holds it', () => {
    const withoutWait = unreachable(
      reachableToolNames(
        granted,
        scopes.filter((scope) => scope !== 'job.wait'),
      ),
    );
    expect(withoutWait.length).toBeGreaterThan(0);
    expect(withoutWait.every((entry) => entry.endsWith(': job.wait'))).toBe(true);
  });

  test('a tool past the first fifteen by name still counts', () => {
    expect(granted.length).toBeGreaterThan(15);
    const last = granted.at(-1)?.name ?? '';
    expect(reachableToolNames(granted, scopes).has(last)).toBe(true);
  });
});
