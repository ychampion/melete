/**
 * Which AWS service a request is for, and how that service is spoken to, from
 * the AWS SDK's own service definitions (`aws-services.json`, written by
 * `apps/melete/scripts/aws-services.py` from botocore's data).
 *
 * A request names its operation according to its service's protocol: query
 * and EC2 services by `Action`, JSON services by `X-Amz-Target` with their own
 * target prefix, CBOR services in the path, and REST services by method and
 * path alone. The relay believes a name only where the service reads it.
 */
import table from './aws-services.json' with { type: 'json' };

export type AwsProtocol =
  | 'query'
  | 'ec2'
  | 'json'
  | 'rest-json'
  | 'rest-xml'
  | 'smithy-rpc-v2-cbor';

export type AwsService = {
  id: string;
  /** The first labels of the service's host name. */
  prefix: string;
  /** The service name in a signature's credential scope. */
  signing: string;
  protocols: AwsProtocol[];
  /** JSON services: what `X-Amz-Target` begins with. */
  target?: string;
  /**
   * REST services: the routes the relay must recognise by name, as
   * `[method, request URI template, operation]`. A GET or HEAD route not
   * listed is named as a read.
   */
  routes?: Array<[string, string, string]>;
};

const SERVICES = (table as { source: string; services: AwsService[] }).services;
export const AWS_SERVICES_SOURCE = (table as { source: string }).source;

const containsLabels = (labels: string[], wanted: string[]) => {
  for (let at = 0; at + wanted.length <= labels.length; at += 1)
    if (wanted.every((label, index) => labels[at + index] === label)) return true;
  return false;
};

/**
 * The services a request signed for `signing` and sent to `host` may be for:
 * those with that signing name whose host prefix appears in the host, or, if
 * none does, every service with that signing name.
 */
export function servicesFor(signing: string, host: string): AwsService[] {
  const all = SERVICES.filter((service) => service.signing === signing);
  const labels = host
    .toLowerCase()
    .replace(/\.amazonaws\.com$/, '')
    .split('.');
  const named = all.filter((service) => containsLabels(labels, service.prefix.split('.')));
  return named.length ? named : all;
}

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compiled = new Map<string, { path: RegExp; query: Array<[string, string | null]> }>();

function compile(uri: string) {
  const seen = compiled.get(uri);
  if (seen) return seen;
  const mark = uri.indexOf('?');
  const template = (mark < 0 ? uri : uri.slice(0, mark)).replace(/(.)\/$/, '$1');
  const pattern = template
    .split(/(\{[^}]+\})/)
    .map((part) => (part.startsWith('{') ? (part.endsWith('+}') ? '.+' : '[^/]+') : literal(part)))
    .join('');
  const query = (mark < 0 ? '' : uri.slice(mark + 1))
    .split('&')
    .filter(Boolean)
    .map((pair): [string, string | null] => {
      const equals = pair.indexOf('=');
      return equals < 0 ? [pair, null] : [pair.slice(0, equals), pair.slice(equals + 1)];
    });
  const entry = { path: new RegExp(`^${pattern}/?$`), query };
  compiled.set(uri, entry);
  return entry;
}

/**
 * The listed REST operation a request matches, by method, path and the
 * literal query parameters its route requires (the most specific route when
 * several match); null when it matches none.
 */
export function restOperation(
  service: AwsService,
  method: string,
  path: string,
  parameters: Record<string, string | string[]>,
): string | null {
  let best: { operation: string; query: number; length: number } | null = null;
  for (const [routeMethod, uri, operation] of service.routes ?? []) {
    if (routeMethod !== method) continue;
    const route = compile(uri);
    if (!route.path.test(path)) continue;
    const present = route.query.every(([name, value]) => {
      const given = parameters[name];
      if (given === undefined) return false;
      return value === null || (Array.isArray(given) ? given.includes(value) : given === value);
    });
    if (!present) continue;
    // The most specific route wins: the most literal query parameters, then the longest template.
    const rank = { operation, query: route.query.length, length: uri.length };
    if (
      !best ||
      rank.query > best.query ||
      (rank.query === best.query && rank.length > best.length)
    )
      best = rank;
  }
  return best?.operation ?? null;
}
