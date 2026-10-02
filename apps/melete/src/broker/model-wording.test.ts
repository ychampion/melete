/**
 * The tools the model reads describe the person it works for as "the person".
 * Its notes and answers borrow these words, so a description that says "the
 * owner" comes back as "The owner asks…" in what the person reads.
 */
import { expect, test } from 'bun:test';
import type { ToolSpec } from '@melete/contracts';
import { artifactsManifest } from '../connectors/artifacts.ts';
import { REACT_TOOL } from '../connectors/catalog.ts';
import { execManifest } from '../connectors/exec.ts';
import { filesManifest } from '../connectors/files.ts';
import { webManifest } from '../connectors/web.ts';
import { LEARNING_TOOL } from '../learning/runtime-route.ts';
import { META_TOOLS, SAY_TOOL, SKILL_READ_TOOL } from './catalog.ts';
import { RESUME_ACTION_TOOL } from './resume.ts';

const described: Pick<ToolSpec, 'name' | 'description'>[] = [
  ...META_TOOLS,
  SAY_TOOL,
  SKILL_READ_TOOL,
  REACT_TOOL,
  RESUME_ACTION_TOOL,
  LEARNING_TOOL,
  ...[filesManifest, webManifest, artifactsManifest, execManifest].flatMap((m) => m.tools),
];

test('no tool description the model reads calls the person "the owner"', () => {
  const saying = described.filter((tool) => /\bowner\b/i.test(tool.description));
  expect(saying.map((tool) => tool.name)).toEqual([]);
  expect(REACT_TOOL.description).toContain("the person's latest message");
});

test('the narration tool asks for what comes next and what was found, never reasoning', () => {
  expect(SAY_TOOL.description).toContain('what you will do next, or what you just found');
  expect(SAY_TOOL.description).toContain('Do not include reasoning');
});
