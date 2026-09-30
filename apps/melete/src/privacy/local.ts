/**
 * The person's own model: an OpenAI-compatible server (Ollama, llama.cpp,
 * vLLM, LM Studio) on this machine or their own network.
 *
 * "Local" is checked, not assumed: the address must be loopback or a private
 * network, by its literal or by every address its name resolves to. A setting
 * that points at a public host would quietly turn private conversations into
 * cloud ones, so it is refused when saved and again before each use.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Detection } from './detect.ts';

export class PrivacyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type LocalModel = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Set once the address is pinned: the name to send as Host to the checked address. */
  host?: string;
};

/** The headers a request to the local model carries: its key, and the Host a pinned address needs. */
export function localHeaders(model: LocalModel): Record<string, string> {
  return {
    ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
    ...(model.host ? { host: model.host } : {}),
  };
}

function ipv4Private(address: string): boolean {
  const parts = address.split('.').map(Number);
  const [a = -1, b = -1] = parts;
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    // Carrier-grade NAT space, which is where a tailnet puts its devices.
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Loopback, link-local or a private network. */
export function isPrivateAddress(address: string): boolean {
  const value = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(value) === 4) return ipv4Private(value);
  if (isIP(value) === 6) {
    if (value === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped?.[1]) return ipv4Private(mapped[1]);
    return /^(?:fc|fd|fe[89ab])/.test(value);
  }
  return false;
}

/** True or false for a literal or a reserved local name; null when only DNS can tell. */
export function localHostLiteral(hostname: string): boolean | null {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host)) return isPrivateAddress(host);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'host.docker.internal') return true;
  return null;
}

type Lookup = (hostname: string) => Promise<{ address: string }[]>;
const systemLookup: Lookup = (hostname) => lookup(hostname, { all: true });

/** Whether every address this URL can reach is on the person's machine or network. */
export async function isLocalUrl(value: string, resolve: Lookup = systemLookup): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  const literal = localHostLiteral(url.hostname);
  if (literal !== null) return literal;
  try {
    const addresses = await resolve(url.hostname);
    return addresses.length > 0 && addresses.every((entry) => isPrivateAddress(entry.address));
  } catch {
    return false;
  }
}

/**
 * Check a local model's address now, for the request about to be sent, and
 * hold it to what was checked. A name is resolved once here; over plain HTTP
 * the request then goes to the checked address with the name as its Host, so
 * the name cannot be re-pointed at a public host between the check and the
 * connection. Over HTTPS the certificate is what binds the name. Null when the
 * address is not on this machine or network now.
 */
export async function pinLocalModel(
  model: LocalModel,
  resolve: Lookup = systemLookup,
): Promise<LocalModel | null> {
  let url: URL;
  try {
    url = new URL(model.baseUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const literal = localHostLiteral(url.hostname);
  if (literal !== null) return literal ? model : null;
  let addresses: { address: string }[];
  try {
    addresses = await resolve(url.hostname);
  } catch {
    return null;
  }
  if (!addresses.length || !addresses.every((entry) => isPrivateAddress(entry.address)))
    return null;
  if (url.protocol === 'https:') return model;
  const host = url.host;
  const address = addresses[0]?.address ?? '';
  url.hostname = isIP(address) === 6 ? `[${address}]` : address;
  return { ...model, baseUrl: url.href, host };
}

export async function assertLocalEndpoint(value: string, resolve?: Lookup): Promise<void> {
  if (!(await isLocalUrl(value, resolve)))
    throw new PrivacyError(
      'local_model_not_local',
      'A local model has to run on this machine or your own network: use a loopback or private address.',
    );
}

/** `<base>/chat/completions`, whatever the person typed after the version prefix. */
export function localEndpoint(model: LocalModel, path: 'chat/completions' | 'models'): URL {
  const base = model.baseUrl.endsWith('/') ? model.baseUrl : `${model.baseUrl}/`;
  return new URL(path, base);
}

type Fetch = (request: Request) => Promise<Response>;

/** Reach the server and list its models, without sending anything personal. */
export async function checkLocalModel(
  model: LocalModel,
  fetcher: Fetch = (request) => fetch(request),
): Promise<{ ok: boolean; message: string; models: string[] }> {
  if (!(await isLocalUrl(model.baseUrl)))
    return {
      ok: false,
      message: 'That address is not on this machine or your network.',
      models: [],
    };
  try {
    const response = await fetcher(
      new Request(localEndpoint(model, 'models').href, {
        headers: localHeaders(model),
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      }),
    );
    if (!response.ok)
      return { ok: false, message: `The server answered ${response.status}.`, models: [] };
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    const models = (body.data ?? [])
      .map((entry) => entry.id)
      .filter((value): value is string => typeof value === 'string')
      .slice(0, 100);
    if (models.length && !models.includes(model.model))
      return {
        ok: false,
        message: `The server is running but has no model named ${model.model}.`,
        models,
      };
    return { ok: true, message: `Connected to ${model.model}.`, models };
  } catch {
    return { ok: false, message: 'Couldn’t reach a model server at that address.', models: [] };
  }
}

const NER_PROMPT = `You find personal details in text. Reply with JSON only:
{"names": [...], "addresses": [...], "health": [...]}
- names: full or partial names of private people (not companies, products or public figures)
- addresses: street addresses and home locations
- health: medical conditions, diagnoses, medications, treatments
Copy each item exactly as it appears in the text. Use empty lists when there are none.`;

const NER_CATEGORIES = { names: 'name', addresses: 'address', health: 'health' } as const;

/**
 * Ask the local model for names, addresses and health details in these texts.
 * It returns spans per text; a failure returns null and the deterministic
 * detectors stand alone for this request.
 */
export async function localDetect(
  model: LocalModel,
  texts: string[],
  fetcher: Fetch = (request) => fetch(request),
  timeoutMs = 8000,
): Promise<Map<string, Detection[]> | null> {
  const joined = texts.join('\n---\n').slice(0, 12_000);
  if (!joined.trim()) return new Map();
  try {
    const response = await fetcher(
      new Request(localEndpoint(model, 'chat/completions').href, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', ...localHeaders(model) },
        body: JSON.stringify({
          model: model.model,
          temperature: 0,
          messages: [
            { role: 'system', content: NER_PROMPT },
            { role: 'user', content: joined },
          ],
        }),
      }),
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;
    const json = /\{[\s\S]*\}/.exec(content)?.[0];
    if (!json) return null;
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const spans = new Map<string, Detection[]>();
    for (const text of texts) spans.set(text, []);
    for (const [key, category] of Object.entries(NER_CATEGORIES)) {
      const items = Array.isArray(parsed[key]) ? parsed[key] : [];
      for (const item of items) {
        if (typeof item !== 'string' || item.trim().length < 2) continue;
        const needle = item.trim();
        for (const text of texts) {
          let from = text.indexOf(needle);
          while (from >= 0) {
            spans.get(text)?.push({ start: from, end: from + needle.length, category });
            from = text.indexOf(needle, from + needle.length);
          }
        }
      }
    }
    return spans;
  } catch {
    return null;
  }
}
