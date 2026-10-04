/**
 * Every tool schema Melete offers the engine names its object keys. The engine
 * fills an object with no `properties` as one that takes none, and a provider
 * that holds arguments to the schema then lets the model send it only empty.
 * A genuinely free-form map says so with `additionalProperties`.
 */
import { describe, expect, test } from 'bun:test';
import * as contracts from '@melete/contracts';
import * as apps from '../connectors/apps.ts';
import * as artifacts from '../connectors/artifacts.ts';
import * as browser from '../connectors/browser.ts';
import * as calendar from '../connectors/calendar.ts';
import * as connectorCatalog from '../connectors/catalog.ts';
import * as email from '../connectors/email.ts';
import * as exec from '../connectors/exec.ts';
import * as files from '../connectors/files.ts';
import * as googleCalendar from '../connectors/google-calendar.ts';
import * as outlookCalendar from '../connectors/outlook-calendar.ts';
import * as sandboxComputer from '../connectors/sandbox-computer.ts';
import * as sandboxExec from '../connectors/sandbox-exec.ts';
import * as sandboxProcess from '../connectors/sandbox-process.ts';
import { createTranscriptionConnector } from '../connectors/transcribe.ts';
import { createCapabilityConnector } from '../connectors/tts.ts';
import * as web from '../connectors/web.ts';
import * as devices from '../devices/connector.ts';
import { CREDENTIAL_ADAPTER_IDS } from '../egress/adapters/types.ts';
import { createCommandLineConnector } from '../egress/connector.ts';
import * as learning from '../learning/runtime-route.ts';
import * as askPerson from './ask-person.ts';
import * as catalog from './catalog.ts';
import * as chase from './chase.ts';
import * as compose from './compose.ts';
import * as resume from './resume.ts';
import * as runtimeWait from './runtime-wait.ts';

type Node = Record<string, unknown>;

/** Object nodes that name neither their keys nor what their values are, by path. */
function looseObjects(node: unknown, path: string, found: string[]): void {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) looseObjects(item, `${path}[${index}]`, found);
  } else if (node && typeof node === 'object') {
    const schema = node as Node;
    if (schema.type === 'object' && !schema.properties && schema.additionalProperties === undefined)
      found.push(path);
    for (const [key, value] of Object.entries(schema)) looseObjects(value, `${path}.${key}`, found);
  }
}

/** Every value shaped like a tool spec, wherever it sits in an export. */
function toolSchemas(value: unknown, out: Map<string, unknown>, seen = new Set<unknown>()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  const node = value as Node;
  if (typeof node.name === 'string' && node.input_schema && typeof node.input_schema === 'object')
    out.set(`${node.name}${out.has(node.name) ? `#${out.size}` : ''}`, node.input_schema);
  for (const child of Array.isArray(value) ? value : Object.values(node))
    toolSchemas(child, out, seen);
}

const built = [
  ...CREDENTIAL_ADAPTER_IDS.map((adapter) => createCommandLineConnector(adapter).manifest),
  createTranscriptionConnector({ workRoot: '/w', spacesRoot: '/s', adapter: null, provider: 'x' })
    .manifest,
  createCapabilityConnector({ spacesRoot: '/s', adapter: null, provider: 'x' }).manifest,
  devices.deviceManifest('Laptop'),
];

describe('tool schemas offered to the engine', () => {
  test('every object names its keys, or says it is a free-form map', () => {
    const schemas = new Map<string, unknown>();
    for (const source of [
      contracts,
      apps,
      artifacts,
      browser,
      calendar,
      connectorCatalog,
      email,
      exec,
      files,
      googleCalendar,
      outlookCalendar,
      sandboxComputer,
      sandboxExec,
      sandboxProcess,
      web,
      devices,
      learning,
      askPerson,
      catalog,
      chase,
      compose,
      resume,
      runtimeWait,
      built,
    ])
      toolSchemas(source, schemas);
    // The walk reaches the tools it is meant to.
    for (const name of ['run.start', 'files.write', 'ask_person', 'compose', 'search_tools'])
      expect([...schemas.keys()]).toContain(name);
    const found: string[] = [];
    for (const [name, schema] of schemas) looseObjects(schema, name, found);
    expect(found).toEqual([]);
  });
});
