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

test('removing a connection retires its connector; shutdown only closes it', async () => {
  const seen: string[] = [];
  const connector = (id: string) =>
    Object.assign(createTestConnector(memoryTestLedger()), {
      close: async () => {
        seen.push(`close ${id}`);
      },
      retire: async () => {
        seen.push(`retire ${id}`);
      },
    });
  const registry = new ConnectorRegistry()
    .register('con_gone', connector('gone'))
    .register('con_kept', connector('kept'));
  const gone = registry.get('con_gone');
  if (!gone) throw new Error('missing connector');
  // A stale reference cannot retire a replacement.
  await registry.remove('con_gone', connector('stale'));
  await registry.remove('con_gone', gone);
  expect(registry.get('con_gone')).toBeUndefined();
  await registry.close();
  expect(seen).toEqual(['retire gone', 'close kept']);
});

test('releasing a gone connection retires its connector and releases what was kept, served or not', async () => {
  const seen: string[] = [];
  const connector = (id: string, retires: boolean) =>
    Object.assign(createTestConnector(memoryTestLedger()), {
      close: async () => {
        seen.push(`close ${id}`);
      },
      ...(retires
        ? {
            retire: async () => {
              seen.push(`retire ${id}`);
            },
          }
        : {}),
    });
  const registry = new ConnectorRegistry()
    .register('con_server', connector('server', true))
    .register('con_mail', connector('mail', false))
    .addReleaser(async (id) => {
      seen.push(`release ${id}`);
    });
  await registry.release('con_server');
  // Never opened here, as a connection in error or on a service that restarted: its data still goes.
  await registry.release('con_unserved');
  // A connector the caller means to keep is left in place, and nothing is released for it.
  await registry.release('con_mail', (item) => Boolean(item.retire));
  expect(registry.get('con_mail')).toBeDefined();
  expect(seen).toEqual(['retire server', 'release con_server', 'release con_unserved']);
});
