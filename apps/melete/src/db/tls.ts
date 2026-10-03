/**
 * How the service's database clients check the server, for a DATABASE_URL that
 * asks for it. Both drivers leave the TLS server name empty when the host is an
 * IP address (SNI cannot carry one), and Node then checks the certificate
 * against "localhost", so a server reached by its address fails `verify-full`
 * even with a certificate made out to that address. Here the certificate is
 * checked against the URL's own host, a name or an address alike, as libpq
 * does:
 * - `verify-full` (or `sslrootcert=system`): the certificate chains to a
 *   trusted authority (Node's own list, plus NODE_EXTRA_CA_CERTS) and is made
 *   out to the host;
 * - `verify-ca`: the certificate chains to a trusted authority;
 * - any other mode: null, and the driver keeps its own reading.
 */
import { checkServerIdentity, type PeerCertificate } from 'node:tls';

export type VerifyingTls = {
  rejectUnauthorized: true;
  checkServerIdentity: (servername: string, certificate: PeerCertificate) => Error | undefined;
};

export function verifyingTls(connectionString: string): VerifyingTls | null {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return null;
  }
  const mode =
    url.searchParams.get('sslmode') ??
    (url.searchParams.get('sslrootcert') === 'system' ? 'verify-full' : null);
  if (mode === 'verify-ca')
    return { rejectUnauthorized: true, checkServerIdentity: () => undefined };
  if (mode !== 'verify-full') return null;
  // An IPv6 host is written in brackets in a URL.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  return {
    rejectUnauthorized: true,
    checkServerIdentity: (_servername, certificate) => checkServerIdentity(host, certificate),
  };
}
