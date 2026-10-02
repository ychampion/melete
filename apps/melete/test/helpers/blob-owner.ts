/**
 * An owner kind for tests: its id is `<space id>/<name>`, and it belongs to
 * that space while the space exists.
 */
import { defineBlobOwner } from '../../src/storage/refs.ts';

export const TEST_BLOB_OWNER = 'test_owner';

defineBlobOwner(TEST_BLOB_OWNER, async (tx, ownerId) => {
  const spaceId = ownerId.split('/')[0] ?? '';
  const [row] = await tx<{ id: string }[]>`select id from space where id = ${spaceId}`;
  return row?.id ?? null;
});

export const testOwner = (spaceId: string, name: string) => ({
  kind: TEST_BLOB_OWNER,
  id: `${spaceId}/${name}`,
});
