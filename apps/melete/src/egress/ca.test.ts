/**
 * The installation's egress CA: name-constrained to the adapters' DNS
 * subtrees, its key sealed for its own purpose, replaced when the subtrees
 * change or its end is near, and short-lived leaves kept in memory.
 */
import { describe, expect, test } from 'bun:test';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:tls';
import {
  CA_ROTATE_BEFORE_MS,
  CA_VALIDITY_MS,
  EGRESS_CA_PURPOSE,
  EgressCertificateAuthority,
  memoryEgressCaStore,
} from './ca.ts';
import { testSealer } from './fixtures.ts';
import { derOf, leafCertificate, newKeyPair, pem } from './x509.ts';

const authority = (constraints: string[] = ['test'], now = () => Date.now()) => {
  const store = memoryEgressCaStore();
  const sealer = testSealer();
  return { store, sealer, ca: new EgressCertificateAuthority({ store, sealer, constraints, now }) };
};

/** Whether a TLS client trusting only `caPem` accepts a server showing `cert` for `host`. */
async function accepted(caPem: string, cert: string, key: string, host: string) {
  const server = createServer({ cert, key }, (_request, response) => response.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<string>((resolve) => {
      const socket = connect({ port, host: '127.0.0.1', servername: host, ca: [caPem] }, () => {
        resolve('accepted');
        socket.destroy();
      });
      socket.once('error', (error: Error) => resolve(`refused: ${error.message}`));
    });
  } finally {
    server.close();
  }
}

describe('the egress CA', () => {
  test('the egress CA cannot sign for a host outside its constraints', async () => {
    const { ca, store, sealer } = authority();
    // It refuses to issue one at all.
    await expect(ca.leaf('evil.example')).rejects.toThrow('does not vouch for evil.example');
    // A leaf forged with its key is refused by a client that trusts it.
    const certificate = await ca.certificate();
    const row = store.rows[0];
    if (!row) throw new Error('no CA was made');
    const key = createPrivateKey(
      await sealer.openForPurpose(EGRESS_CA_PURPOSE, row.id, row.sealedKey),
    );
    const forgedKeys = newKeyPair();
    const forged = leafCertificate({
      host: 'evil.example',
      keys: forgedKeys,
      caCert: derOf('CERTIFICATE', certificate.pem),
      caKey: key,
      caCommonName: 'Melete egress CA',
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 3_600_000),
    });
    const forgedKey = forgedKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(
      await accepted(certificate.pem, pem('CERTIFICATE', forged), forgedKey, 'evil.example'),
    ).toMatch(/^refused/);
    // The same CA's leaf for a permitted host is accepted.
    const leaf = await ca.leaf('api.creds.test');
    expect(await accepted(certificate.pem, leaf.cert, leaf.key, 'api.creds.test')).toBe('accepted');
  });

  test('the CA is constrained to the adapters and holds no address, and its key is sealed for its purpose', async () => {
    const { ca, store, sealer } = authority(['test', '.creds.example']);
    const certificate = new X509Certificate((await ca.certificate()).pem);
    expect(certificate.ca).toBe(true);
    const row = store.rows[0];
    if (!row) throw new Error('no CA was made');
    expect(row.nameConstraints).toEqual(['creds.example', 'test']);
    expect(row.sealedKey).not.toContain('PRIVATE KEY');
    await expect(sealer.openForPurpose('another-purpose', row.id, row.sealedKey)).rejects.toThrow();
    await expect(
      sealer.openForPurpose(EGRESS_CA_PURPOSE, 'eca_other', row.sealedKey),
    ).rejects.toThrow();
    expect(new Date(certificate.validTo).getTime()).toBeGreaterThan(
      Date.now() + CA_VALIDITY_MS - 86_400_000,
    );
    // An address is never vouched for.
    await expect(ca.leaf('10.0.0.1')).rejects.toThrow();
  });

  test('a leaf lasts a day and is reused; the CA is replaced when its subtrees change or its end nears', async () => {
    let now = Date.now();
    const store = memoryEgressCaStore();
    const sealer = testSealer();
    const first = new EgressCertificateAuthority({
      store,
      sealer,
      constraints: ['test'],
      now: () => now,
    });
    const leaf = await first.leaf('api.creds.test');
    expect(leaf.notAfter - now).toBeLessThanOrEqual(86_400_000);
    expect(await first.leaf('api.creds.test')).toBe(leaf);
    // Another process, same constraints: the same CA.
    const same = new EgressCertificateAuthority({
      store,
      sealer,
      constraints: ['test'],
      now: () => now,
    });
    expect((await same.certificate()).id).toBe((await first.certificate()).id);
    expect(store.rows).toHaveLength(1);
    // Different subtrees: a new CA.
    const wider = new EgressCertificateAuthority({
      store,
      sealer,
      constraints: ['test', 'creds.example'],
      now: () => now,
    });
    await wider.certificate();
    expect(store.rows).toHaveLength(2);
    // Ninety days before the end: replaced, and leaves come from the new one.
    now += CA_VALIDITY_MS - CA_ROTATE_BEFORE_MS + 1;
    const renewed = await wider.leaf('api.creds.test');
    expect(store.rows).toHaveLength(3);
    expect(renewed.caId).toBe(store.rows[2]?.id ?? '');
  });
});

test('a CA whose key the master key cannot open is replaced, not left failing', async () => {
  const store = memoryEgressCaStore();
  const before = new EgressCertificateAuthority({
    store,
    sealer: testSealer(),
    constraints: ['test'],
  });
  await before.certificate();
  // The master key was replaced.
  const after = new EgressCertificateAuthority({
    store,
    sealer: testSealer(),
    constraints: ['test'],
  });
  const leaf = await after.leaf('api.creds.test');
  expect(store.rows).toHaveLength(2);
  expect(leaf.caId).toBe(store.rows[1]?.id ?? '');
});
