import { expect, test } from 'bun:test';
import { ConnectorRegistry } from './registry.ts';
import { createTestConnector, memoryTestLedger } from './test.ts';

test('registry rejects duplicate connections and returns a stable connection order', () => {
  const connector = createTestConnector(memoryTestLedger());
  const registry = new ConnectorRegistry()
    .register('con_z', connector)
    .register('con_a', connector);
  expect(registry.entries().map(([id]) => id)).toEqual(['con_a', 'con_z']);
  expect(registry.get('con_z')).toBe(connector);
  expect(registry.get('con_missing')).toBeUndefined();
  expect(() => registry.register('con_a', connector)).toThrow('already registered');
});

test('registry refuses ambiguous tools and invalid manifests', () => {
  const connector = createTestConnector(memoryTestLedger());
  const tool = connector.manifest.tools[0];
  if (!tool) throw new Error('test tool missing');
  connector.manifest.tools.push(tool);
  expect(() => new ConnectorRegistry().register('con_a', connector)).toThrow(
    'duplicate connector tool',
  );
  connector.manifest.tools = [];
  expect(() => new ConnectorRegistry().register('con_a', connector)).toThrow();
});
