/**
 * Switched off, a room connection offers no tools: the rows stay as they were,
 * and the factory that turns rows into connectors opens nothing for them.
 */
import { describe, expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import { ConnectorFactory } from '../connectors/configured.ts';
import { multiplayerEnabled, multiplayerPath } from './preview.ts';

const roomRow = (builtin: string) => ({
  id: 'conn_01M2000000000000000000000A',
  spaceId: 'spc_01M2000000000000000000000A',
  provider: 'room',
  secretRef: null,
  configuration: { builtin },
});

const factory = (multiplayer?: boolean, env: Record<string, string> = {}) =>
  new ConnectorFactory({
    sql: {} as Sql,
    workRoot: '/tmp/work',
    spacesRoot: '/tmp/spaces',
    env,
    ...(multiplayer === undefined ? {} : { multiplayer }),
  });

describe('room tools and the multiplayer switch', () => {
  test('off, neither room connection is opened, so no room tool is offered', async () => {
    for (const builtin of ['rooms', 'room_handoff']) {
      expect(await factory(false).open(roomRow(builtin))).toBeUndefined();
      // Left out, the setting is read from the environment, where it defaults to off.
      expect(await factory(undefined).open(roomRow(builtin))).toBeUndefined();
    }
  });

  test('on, both open with the room tools', async () => {
    // Set by the service from its settings, or read from the environment.
    for (const made of [
      factory(true),
      factory(undefined, { MELETE_PREVIEW_MULTIPLAYER: 'true' }),
    ]) {
      const connector = await made.open(roomRow('rooms'));
      expect(connector?.manifest.tools.map((tool) => tool.name)).toContain('room.handoff');
      expect(connector?.manifest.tools.map((tool) => tool.name)).toContain('room.post');
    }
  });

  test('the switch reads parsed and raw settings alike', () => {
    expect(multiplayerEnabled(undefined)).toBe(false);
    expect(multiplayerEnabled({})).toBe(false);
    expect(multiplayerEnabled({ MELETE_PREVIEW_MULTIPLAYER: 'false' })).toBe(false);
    expect(multiplayerEnabled({ MELETE_PREVIEW_MULTIPLAYER: false })).toBe(false);
    expect(multiplayerEnabled({ MELETE_PREVIEW_MULTIPLAYER: 'true' })).toBe(true);
    expect(multiplayerEnabled({ MELETE_PREVIEW_MULTIPLAYER: true })).toBe(true);
  });

  test('a personal space and its removal stay outside the switch', () => {
    expect(multiplayerPath('GET', '/spaces')).toBe(false);
    expect(multiplayerPath('DELETE', '/spaces/spc_1')).toBe(false);
    expect(multiplayerPath('DELETE', '/spaces/spc_1/memberships/prn_1')).toBe(false);
    expect(multiplayerPath('GET', '/roomsy')).toBe(false);
    expect(multiplayerPath('PATCH', '/me')).toBe(false);
  });
});
