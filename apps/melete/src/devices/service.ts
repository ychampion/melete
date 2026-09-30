/**
 * Pairing, authenticating, changing and revoking connected computers.
 *
 * Pairing is two steps. Settings asks for a code: eight characters from an
 * alphabet without look-alikes, stored only as a hash, usable once, for ten
 * minutes. The companion sends the code with the computer's name, what it
 * allows and the folders the person chose there; the code is spent in the
 * same statement that checks it, so two companions racing with one code
 * cannot both win. The companion then receives a token, which the service
 * keeps only as a hash.
 *
 * A paired computer is a `connection` row with provider `device`. Its scopes
 * are the tools both sides allow, recomputed whenever either side changes.
 * Revoking marks the device, revokes the connection through the same
 * lifecycle every connection uses (so running work is fenced), and tells the
 * hub to hand nothing more to the computer.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  DEVICE_LIMITS,
  type DeviceCapabilities,
  type DeviceFolder,
  type DevicePlatform,
  type DeviceView,
  deviceView,
} from '@melete/contracts';
import { and, desc, eq, gt, isNull, sql as query } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { connectorFactoryFor, connectorOptionsFromEnv } from '../connectors/configured.ts';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import type { Database } from '../db/client.ts';
import { connection } from '../db/schema.ts';
import { serviceTransaction } from '../db/transaction.ts';
import type { Env } from '../env.ts';
import { newId } from '../ids.ts';
import type { PolicyService } from '../jobs/policy.ts';
import { spaceAuthority } from '../principals/authority.ts';
import { deviceScopes } from './connector.ts';
import { type DeviceHub, sharedDeviceHub } from './hub.ts';
import { devicePairing, pairedDevice } from './schema.ts';

/** No 0/O, 1/I/L: a code read aloud or copied by eye is typed right. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const TOKEN_PATTERN = /^mdt_[A-Za-z0-9_-]{43}$/;

export const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');

/** Case, spaces and dashes are forgiven; anything else makes the code wrong. */
export const normalizeCode = (value: string) => value.toUpperCase().replace(/[\s-]/g, '');

export function newPairingCode(): string {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index++)
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export const showCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** Folder names are how the agent names paths, so two folders never share one. */
export function checkFolders(folders: readonly DeviceFolder[]): DeviceFolder[] {
  const names = new Set<string>();
  for (const folder of folders) {
    const key = folder.name.toLowerCase();
    if (names.has(key))
      throw new ServiceError('invalid_request', 'Each shared folder needs its own name.', 400);
    names.add(key);
  }
  return [...folders];
}

type DeviceRow = typeof pairedDevice.$inferSelect;
export type AuthenticatedDevice = DeviceRow & { connectionGeneration: number };

export type DeviceServiceDeps = {
  db: Database;
  sql: Sql;
  registry: ConnectorRegistry;
  env: Env;
  policy?: PolicyService;
  hub?: DeviceHub;
  now?: () => Date;
};

export class DeviceService {
  readonly hub: DeviceHub;
  private readonly now: () => Date;

  constructor(private readonly deps: DeviceServiceDeps) {
    this.hub = deps.hub ?? sharedDeviceHub;
    this.now = deps.now ?? (() => new Date());
  }

  view(row: DeviceRow, connectionStatus: string): DeviceView {
    const revoked = row.revokedAt !== null || connectionStatus === 'revoked';
    const seen = this.hub.lastSeen(row.id);
    const lastSeen =
      seen !== undefined && (!row.lastSeenAt || seen > row.lastSeenAt.getTime())
        ? new Date(seen)
        : row.lastSeenAt;
    return deviceView.parse({
      id: row.id,
      connection_id: row.connectionId,
      name: row.name,
      platform: row.platform,
      capabilities: row.capabilities,
      local_capabilities: row.localCapabilities,
      folders: row.folders,
      status: revoked ? 'revoked' : this.hub.online(row.id) ? 'online' : 'offline',
      companion_version: row.companionVersion,
      paired_at: row.pairedAt.toISOString(),
      last_seen_at: lastSeen?.toISOString() ?? null,
      revoked_at: (row.revokedAt ?? (revoked ? row.pairedAt : null))?.toISOString() ?? null,
    });
  }

  /** Devices belong to a space whose owner is the person asking. */
  private async requireOwner(spaceId: string, actor: string) {
    const access = await spaceAuthority(this.deps.db, spaceId, actor);
    if (access.role !== 'owner' || access.space.audience !== 'owner')
      throw new ServiceError(
        'scope_denied',
        'Only the owner of this space connects computers.',
        403,
      );
  }

  async list(spaceId: string, actor: string): Promise<DeviceView[]> {
    await this.requireOwner(spaceId, actor);
    const rows = await this.deps.db
      .select({ device: pairedDevice, status: connection.status })
      .from(pairedDevice)
      .innerJoin(connection, eq(connection.id, pairedDevice.connectionId))
      .where(eq(pairedDevice.spaceId, spaceId))
      .orderBy(desc(pairedDevice.pairedAt));
    return rows.map((row) => this.view(row.device, row.status));
  }

  async get(id: string, actor: string): Promise<{ row: DeviceRow; status: string }> {
    const [found] = await this.deps.db
      .select({ device: pairedDevice, status: connection.status })
      .from(pairedDevice)
      .innerJoin(connection, eq(connection.id, pairedDevice.connectionId))
      .where(eq(pairedDevice.id, id));
    if (!found) throw new ServiceError('not_found', 'Device not found.', 404);
    try {
      await this.requireOwner(found.device.spaceId, actor);
    } catch {
      // Someone else's computer is not acknowledged to exist.
      throw new ServiceError('not_found', 'Device not found.', 404);
    }
    return { row: found.device, status: found.status };
  }

  async createPairing(spaceId: string, actor: string, capabilities: DeviceCapabilities) {
    await this.requireOwner(spaceId, actor);
    const code = newPairingCode();
    const expiresAt = new Date(this.now().getTime() + DEVICE_LIMITS.pairing_ttl_ms);
    await this.deps.db.insert(devicePairing).values({
      id: newId('dpr'),
      spaceId,
      principalId: actor,
      codeHash: hashSecret(code),
      capabilities,
      expiresAt,
    });
    return { code: showCode(code), expires_at: expiresAt.toISOString() };
  }

  /** Spend a code and make the computer's connection. Null when the code is wrong, used or expired. */
  async pair(input: {
    code: string;
    name: string;
    platform: DevicePlatform;
    companion_version: string;
    capabilities: DeviceCapabilities;
    folders: DeviceFolder[];
  }) {
    const code = normalizeCode(input.code);
    if (code.length !== CODE_LENGTH) return null;
    const folders = checkFolders(input.folders);
    const token = `mdt_${randomBytes(32).toString('base64url')}`;
    const deviceId = newId('dev');
    const connectionId = newId('conn');
    const paired = await serviceTransaction(this.deps.db, async (tx) => {
      const [spent] = await tx
        .update(devicePairing)
        .set({ usedAt: this.now(), deviceId })
        .where(
          and(
            eq(devicePairing.codeHash, hashSecret(code)),
            isNull(devicePairing.usedAt),
            gt(devicePairing.expiresAt, this.now()),
          ),
        )
        .returning();
      if (!spent) return null;
      // The person who made the code must still own the space it was made in.
      const access = await spaceAuthority(tx, spent.spaceId, spent.principalId, true);
      if (access.role !== 'owner' || access.space.audience !== 'owner') return null;
      await tx.insert(connection).values({
        id: connectionId,
        spaceId: spent.spaceId,
        provider: 'device',
        label: input.name,
        scopes: deviceScopes(spent.capabilities, input.capabilities),
        configuration: { kind: 'device', device_id: deviceId },
        status: 'disabled',
        setupState: 'connecting',
        health: 'ok',
      });
      await tx.insert(pairedDevice).values({
        id: deviceId,
        spaceId: spent.spaceId,
        connectionId,
        name: input.name,
        platform: input.platform,
        tokenHash: hashSecret(token),
        capabilities: spent.capabilities,
        localCapabilities: input.capabilities,
        folders,
        companionVersion: input.companion_version || null,
        pairedBy: spent.principalId,
        lastSeenAt: this.now(),
      });
      return spent;
    });
    if (!paired) return null;
    // Registry publication precedes activation, as for every installation, so
    // discovery never sees an active row without a connector behind it.
    const factory = connectorFactoryFor(this.deps.registry, () =>
      connectorOptionsFromEnv(this.deps.sql, this.deps.env),
    );
    const connector = await factory.open({
      id: connectionId,
      spaceId: paired.spaceId,
      provider: 'device',
      secretRef: null,
      configuration: { kind: 'device', device_id: deviceId },
    });
    if (!connector) throw new Error('The device connector could not be opened');
    factory.register(this.deps.registry, connectionId, connector);
    await this.deps.db
      .update(connection)
      .set({ status: 'active', setupState: 'connected', lastCheckedAt: this.now() })
      .where(eq(connection.id, connectionId));
    this.hub.touch(deviceId);
    return {
      device_id: deviceId,
      token,
      name: input.name,
      capabilities: paired.capabilities,
    };
  }

  /** The computer a token belongs to, while both it and its connection stand. */
  async authenticate(header: string | undefined): Promise<AuthenticatedDevice | null> {
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!TOKEN_PATTERN.test(token)) return null;
    const [found] = await this.deps.db
      .select({
        device: pairedDevice,
        status: connection.status,
        generation: connection.generation,
      })
      .from(pairedDevice)
      .innerJoin(connection, eq(connection.id, pairedDevice.connectionId))
      .where(eq(pairedDevice.tokenHash, hashSecret(token)));
    if (!found || found.device.revokedAt || found.status === 'revoked') return null;
    return { ...found.device, connectionGeneration: found.generation };
  }

  /** The companion says what it allows now; the connection's scopes follow. */
  async hello(
    device: AuthenticatedDevice,
    input: { companion_version: string; capabilities: DeviceCapabilities; folders: DeviceFolder[] },
  ) {
    const folders = checkFolders(input.folders);
    await this.deps.db.transaction(async (tx) => {
      await tx
        .update(pairedDevice)
        .set({
          localCapabilities: input.capabilities,
          folders,
          companionVersion: input.companion_version || null,
          lastSeenAt: this.now(),
        })
        .where(and(eq(pairedDevice.id, device.id), isNull(pairedDevice.revokedAt)));
      await tx
        .update(connection)
        .set({ scopes: deviceScopes(device.capabilities, input.capabilities) })
        .where(
          and(eq(connection.id, device.connectionId), query`${connection.status} <> 'revoked'`),
        );
    });
    this.hub.touch(device.id);
    return { device_id: device.id, name: device.name, capabilities: device.capabilities };
  }

  /** Remember, now and then, when the computer was last heard from. */
  async seen(device: AuthenticatedDevice) {
    const last = device.lastSeenAt?.getTime() ?? 0;
    if (this.now().getTime() - last < 60_000) return;
    await this.deps.db
      .update(pairedDevice)
      .set({ lastSeenAt: this.now() })
      .where(eq(pairedDevice.id, device.id));
  }

  async update(id: string, actor: string, change: Partial<DeviceCapabilities>) {
    const { row, status } = await this.get(id, actor);
    if (row.revokedAt || status === 'revoked')
      throw new ServiceError('conflict', 'This computer was disconnected. Pair it again.', 409);
    const capabilities = { ...row.capabilities, ...change };
    await this.deps.db.transaction(async (tx) => {
      await tx.update(pairedDevice).set({ capabilities }).where(eq(pairedDevice.id, id));
      await tx
        .update(connection)
        .set({ scopes: deviceScopes(capabilities, row.localCapabilities) })
        .where(eq(connection.id, row.connectionId));
    });
    return this.view({ ...row, capabilities }, status);
  }

  async revoke(id: string, actor: string) {
    const { row } = await this.get(id, actor);
    const revokedAt = row.revokedAt ?? this.now();
    await this.deps.db
      .update(pairedDevice)
      .set({ revokedAt })
      .where(and(eq(pairedDevice.id, id), isNull(pairedDevice.revokedAt)));
    // The token stops working with the row above. The connection is revoked
    // through the lifecycle every connection uses, which fences running work.
    for (let tries = 0; tries < 3; tries++) {
      const [current] = await this.deps.db
        .select({ status: connection.status, generation: connection.generation })
        .from(connection)
        .where(eq(connection.id, row.connectionId));
      if (!current || current.status === 'revoked') break;
      try {
        if (this.deps.policy)
          await this.deps.policy.changeConnection(row.connectionId, {
            kind: 'revoke',
            expected_generation: current.generation,
          });
        else
          await this.deps.db
            .update(connection)
            .set({ status: 'revoked', generation: current.generation + 1 })
            .where(eq(connection.id, row.connectionId));
        break;
      } catch (error) {
        if (!(error instanceof ServiceError) || error.code !== 'generation_conflict') throw error;
      }
    }
    await this.deps.registry.release(row.connectionId).catch(() => {
      process.stderr.write('a revoked device could not release its connector\n');
    });
    this.hub.disconnect(id);
    return this.view({ ...row, revokedAt }, 'revoked');
  }
}
