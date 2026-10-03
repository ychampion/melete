/**
 * The command-line account parts an installation runs: which adapters it
 * offers, its egress CA, and the port the egress guard asks. With no adapter
 * offered there is no CA and no port, and every computer's egress is exactly
 * what it was without them.
 */
import type { Sql } from 'postgres';
import { PostgresSecretRepository, SealedSecretStore } from '../connectors/secrets.ts';
import { credentialAdapters } from './adapters/index.ts';
import { EgressCertificateAuthority, postgresEgressCaStore } from './ca.ts';
import { type EgressCredentialPort, postgresEgressCredentials } from './credentials.ts';
import type { InterceptOptions } from './intercept.ts';

export function egressCredentialsFromEnv(
  sql: Sql,
  env: {
    MELETE_MASTER_KEY?: string | undefined;
    MELETE_ENABLE_TEST_CONNECTOR?: boolean | undefined;
    MELETE_EGRESS_HOLD_MAX_BYTES?: number | undefined;
    MELETE_EGRESS_APPROVAL_HOLD_SECONDS?: number | undefined;
  },
): { credentials: EgressCredentialPort; intercept: InterceptOptions } | undefined {
  const adapters = credentialAdapters({ test: env.MELETE_ENABLE_TEST_CONNECTOR === true });
  if (!adapters.size || !env.MELETE_MASTER_KEY) return undefined;
  const secrets = new SealedSecretStore(
    new PostgresSecretRepository(sql),
    () => env.MELETE_MASTER_KEY,
  );
  const ca = new EgressCertificateAuthority({
    store: postgresEgressCaStore(sql),
    sealer: secrets,
    constraints: [...adapters.values()].flatMap((adapter) => adapter.constraints),
  });
  return {
    credentials: postgresEgressCredentials({ sql, secrets, adapters, ca }),
    intercept: {
      ...(env.MELETE_EGRESS_HOLD_MAX_BYTES
        ? { holdMaxBytes: env.MELETE_EGRESS_HOLD_MAX_BYTES }
        : {}),
      ...(env.MELETE_EGRESS_APPROVAL_HOLD_SECONDS
        ? { approvalHoldSeconds: env.MELETE_EGRESS_APPROVAL_HOLD_SECONDS }
        : {}),
    },
  };
}
