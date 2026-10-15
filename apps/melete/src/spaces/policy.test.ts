import { describe, expect, test } from 'bun:test';
import type { ToolSpec } from '@melete/contracts';
import { grantedToolCatalog } from '../connectors/catalog.ts';
import type { Connector } from '../connectors/types.ts';
import { NO_ROUTING, serviceFallback } from '../gateway/routing.ts';
import {
  allowedChoices,
  allowedRoutes,
  connectorDenied,
  modelAllowed,
  modelRefusal,
  NO_RULES,
  type SpaceRules,
  toolDenied,
} from './policy.ts';

const rules = (partial: Partial<SpaceRules>): SpaceRules => ({ ...NO_RULES, ...partial });
const fast = { provider: 'fireworks', model: 'accounts/fireworks/models/fast' };
const big = { provider: 'anthropic', model: 'fixture-large' };

describe('models a space allows', () => {
  test('with no list, every model', () => {
    expect(modelAllowed(NO_RULES, fast)).toBe(true);
    expect(allowedRoutes(NO_RULES, { fallback: [fast] })).toEqual({ fallback: [fast] });
  });

  test('with a list, only the models on it, split at the first slash', () => {
    const only = rules({ allowedModels: ['fireworks/accounts/fireworks/models/fast'] });
    expect(modelAllowed(only, fast)).toBe(true);
    expect(modelAllowed(only, big)).toBe(false);
    expect(allowedChoices(only)).toEqual([fast]);
  });

  test('a route to a model left out is dropped, and no routes left is none', () => {
    const only = rules({ allowedModels: ['anthropic/fixture-large'] });
    expect(allowedRoutes(only, { vision: fast, fallback: [fast, big] })).toEqual({
      fallback: [big],
    });
    expect(allowedRoutes(only, { vision: fast })).toBeUndefined();
  });

  test("a side call's fallbacks keep to the list its space's rules hold it to", () => {
    const other = { provider: 'fireworks', model: 'accounts/fireworks/models/other' };
    const routing = { ...NO_ROUTING, fallback: [other, fast] };
    // Held to nothing, every fallback that speaks its protocol.
    expect(serviceFallback(routing, fast)).toEqual([other]);
    const held = { ...fast, allowed: [`${fast.provider}/${fast.model}`] };
    expect(serviceFallback(routing, held)).toEqual([]);
    expect(
      serviceFallback(routing, { ...held, allowed: [...held.allowed, `fireworks/${other.model}`] }),
    ).toEqual([other]);
  });

  test('the refusal names what is allowed and what was not used', () => {
    const two = rules({ allowedModels: ['anthropic/a', 'openai/b'] });
    const said = modelRefusal(two, fast);
    expect(said).toContain('anthropic/a or openai/b');
    expect(said).toContain(`${fast.provider}/${fast.model} was not used`);
  });
});

describe('tools and connections a space denies', () => {
  test('a tool by its name, or a family up to a dot, and never a longer word', () => {
    const denied = rules({ deniedToolKinds: ['email', 'files.delete'] });
    expect(toolDenied(denied, 'email.send')).toBe(true);
    expect(toolDenied(denied, 'Email.Read')).toBe(true);
    expect(toolDenied(denied, 'emailer.run')).toBe(false);
    expect(toolDenied(denied, 'files.delete')).toBe(true);
    expect(toolDenied(denied, 'files.read')).toBe(false);
    expect(toolDenied(NO_RULES, 'email.send')).toBe(false);
  });

  test('a connection by its provider', () => {
    expect(connectorDenied(rules({ deniedConnectorKinds: ['mcp'] }), 'MCP')).toBe(true);
    expect(connectorDenied(rules({ deniedConnectorKinds: ['mcp'] }), 'imap')).toBe(false);
  });

  test('the granted catalog leaves out what the rules deny', () => {
    const tool = (name: string) =>
      ({
        name,
        description: name,
        input_schema: { type: 'object', properties: {} },
        effect_class: 'read',
        required_scopes: [],
      }) as unknown as ToolSpec & { required_scopes: string[] };
    const connector = (provider: string, names: string[]) =>
      ({ manifest: { provider, tools: names.map(tool) } }) as unknown as Connector;
    const registry = new Map<string, Connector>([
      ['conn_mail', connector('imap', ['email.read', 'email.send'])],
      ['conn_web', connector('web', ['web.fetch'])],
    ]);
    const grants = [
      { id: 'conn_mail', provider: 'imap', scopes: ['email.read', 'email.send'] },
      { id: 'conn_web', provider: 'web', scopes: ['web.fetch'] },
    ];
    const names = (r?: SpaceRules) =>
      grantedToolCatalog(grants, registry, undefined, r)
        .map((spec) => spec.name)
        .filter((name) => name !== 'react');
    expect(names()).toEqual(['email.read', 'email.send', 'web.fetch']);
    expect(names(rules({ deniedToolKinds: ['email.send'] }))).toEqual(['email.read', 'web.fetch']);
    expect(names(rules({ deniedConnectorKinds: ['imap'] }))).toEqual(['web.fetch']);
  });
});
