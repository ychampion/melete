/**
 * The request headers the stateless MCP revision (2026-07-28) mirrors from a
 * request's body over Streamable HTTP: `Mcp-Name`, and one `Mcp-Param-{Name}`
 * for each tool parameter whose schema carries `x-mcp-header`. Values that are
 * not plain visible ASCII travel in the specification's Base64 sentinel form,
 * so nothing a model wrote can add a header line or break one.
 */
import type { JsonObject } from '@melete/contracts';

const SENTINEL = /^=\?base64\?.*\?=$/s;
/** Visible ASCII, inner spaces and tabs, no leading or trailing whitespace. */
const PLAIN = /^[\x21-\x7e](?:[\x20-\x7e\t]*[\x21-\x7e])?$/;
/** RFC 9110 `token`: the characters a header field name may hold. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A value as a header carries it: as it is when plain, otherwise in the Base64 sentinel form. */
export function mcpHeaderValue(value: string): string {
  return PLAIN.test(value) && !SENTINEL.test(value)
    ? value
    : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Where one annotated parameter sits, and the header it is mirrored into. */
export type McpParamHeader = { header: string; path: string[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The `x-mcp-header` annotations of a tool's input schema, or null when any of
 * them breaks the specification's rules: a name that is not a header token or
 * repeats another (ignoring case), a parameter that is not a string, integer or
 * boolean, or one reached through anything but a chain of `properties`. A
 * client must not offer a tool whose annotations are invalid.
 */
export function mcpParamHeaders(schema: Record<string, unknown>): McpParamHeader[] | null {
  const found: McpParamHeader[] = [];
  let valid = true;
  const visit = (node: unknown, chain: string[] | null) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, null);
      return;
    }
    if (!isObject(node)) return;
    if (Object.hasOwn(node, 'x-mcp-header')) {
      const name = node['x-mcp-header'];
      if (
        !chain?.length ||
        typeof name !== 'string' ||
        !TOKEN.test(name) ||
        !['string', 'integer', 'boolean'].includes(String(node.type))
      )
        valid = false;
      else found.push({ header: `Mcp-Param-${name}`, path: chain });
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'properties' && chain && isObject(child)) {
        for (const [property, inner] of Object.entries(child)) visit(inner, [...chain, property]);
      } else visit(child, null);
    }
  };
  visit(schema, []);
  const names = found.map((item) => item.header.toLowerCase());
  if (new Set(names).size !== names.length) valid = false;
  return valid ? found : null;
}

/** The `Mcp-Param-*` headers one call carries: a header for each annotated value present. */
export function mcpParamHeaderValues(
  annotated: readonly McpParamHeader[],
  args: JsonObject,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { header, path } of annotated) {
    let value: unknown = args;
    for (const key of path) value = isObject(value) ? value[key] : undefined;
    if (typeof value === 'string') headers[header] = mcpHeaderValue(value);
    else if (typeof value === 'boolean') headers[header] = String(value);
    else if (typeof value === 'number' && Number.isSafeInteger(value))
      headers[header] = String(value);
  }
  return headers;
}
