/**
 * A skill is offered only when every tool it names is in the attempt's
 * catalog, so a built-in that names a tool nothing provides is never offered at
 * all. This holds the built-ins to the tools that exist.
 */
import { describe, expect, test } from 'bun:test';
import { loadBuiltInSkills } from '@melete/skills';
import { RUNTIME_WAIT_TOOL } from '../broker/runtime-wait.ts';
import { artifactsManifest } from './artifacts.ts';
import { browserManifest } from './browser.ts';
import { calendarManifest } from './calendar.ts';
import { REACT_TOOL } from './catalog.ts';
import { emailManifest } from './email.ts';
import { execManifest } from './exec.ts';
import { filesManifest } from './files.ts';
import { speechCapability } from './tts.ts';
import { webManifest } from './web.ts';

const PROVIDED = new Set([
  ...[
    artifactsManifest,
    browserManifest,
    calendarManifest,
    emailManifest,
    execManifest,
    filesManifest,
    webManifest,
  ].flatMap((manifest) => manifest.tools.map((tool) => tool.name)),
  speechCapability(null, 'none', 0).kind,
  RUNTIME_WAIT_TOOL.name,
  REACT_TOOL.name,
]);

describe('the tools a built-in skill names', () => {
  test('are all tools a connector, a capability or the broker provides', () => {
    const unknown = loadBuiltInSkills().skills.flatMap((skill) =>
      skill.frontmatter.tools
        .filter((tool) => !PROVIDED.has(tool))
        .map((tool) => `${skill.frontmatter.name}: ${tool}`),
    );
    expect(unknown).toEqual([]);
  });
});
