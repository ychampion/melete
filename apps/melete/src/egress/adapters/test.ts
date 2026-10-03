/**
 * The adapter the relay's own tests and the test connector use: a bearer
 * token on hosts the connection names, all under the reserved `.test` domain.
 * `GET` and `HEAD` read; every other method is a write, and `DELETE` is
 * destructive. A write to a host listed as read only is refused. It is
 * offered only where the test connector is.
 */
import { z } from 'zod';
import { requestWrite } from './generic.ts';
import type { CredentialAdapter, OutboundRequest } from './types.ts';
import { hostCovered } from './types.ts';

/** Names under the reserved `.test` domain only, the one subtree this adapter's CA may vouch for. */
const dnsName = z
  .string()
  .min(1)
  .max(253)
  .regex(/^\.?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+test$/);

export const testAdapterConfig = z
  .object({
    hosts: z.array(dnsName).min(1).max(16),
    read_only_hosts: z.array(dnsName).max(16).default([]),
  })
  .strict();
export type TestAdapterConfig = z.infer<typeof testAdapterConfig>;

const READS = new Set(['GET', 'HEAD']);

export const testAdapter: CredentialAdapter<TestAdapterConfig> = {
  id: 'test',
  constraints: ['test'],
  parseConfig: (value) => testAdapterConfig.parse(value),
  hosts: (config) => config.hosts,
  placeholders: () => ({}),
  classify(request, config) {
    if (READS.has(request.method)) return { kind: 'read' };
    if (hostCovered(request.host, config.read_only_hosts))
      return { kind: 'refuse', reason: `${request.host} is read only for this account.` };
    return requestWrite(request);
  },
  authorize: (request: OutboundRequest, secret: string): OutboundRequest => ({
    ...request,
    headers: { ...request.headers, authorization: `Bearer ${secret}` },
  }),
  redactions: (secret) => [secret],
  receipt: (_write, upstream) => ({ status: upstream.status }),
};
