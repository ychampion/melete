/**
 * Pages a connection shows the person, and what the person's account is
 * entitled to.
 *
 * A tool on a connected MCP server can carry an interactive page: the MCP Apps
 * extension's `ui://` resource, an HTML document the server provides. Melete
 * draws it in the conversation, in a sandboxed frame with an opaque origin and
 * a policy built from the domains the page declares and the connection allows.
 * The page talks to Melete only through the MCP Apps messages (see
 * `apps/web/src/chat/page-bridge.ts`); nothing it says can settle anything.
 *
 * What the person did on the page is reported by the connection's server,
 * never by the page: Melete hands the server a one-time report key with the
 * tool call, and the server signs its report with it, the way Standard
 * Webhooks are signed. The conversation waits on that report and goes on
 * when it arrives, or when the page expires.
 */
import { z } from 'zod';
import { ID_PREFIXES, jsonObject, prefixedId, timestamp } from './common.ts';

/** The MCP Apps extension, as a client declares it and a server marks a tool with it. */
export const MCP_UI_EXTENSION = 'io.modelcontextprotocol/ui';
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
/** Melete's own `_meta` key on a tool call that may open a page. */
export const PAGE_META_KEY = 'io.melete/page';
/** The request header that carries the identity assertion to a remote connection. */
export const IDENTITY_HEADER = 'Melete-Identity';
/** Where an installation publishes the keys its identity assertions are signed with, below its API. */
export const IDENTITY_JWKS_PATH = '/.well-known/jwks.json';

export const PAGE_LIMITS = {
  /** The largest page document Melete keeps and serves. */
  html_max_bytes: 512 * 1024,
  /** Domains one page may name, per kind (connect, resource, frame). */
  domains_max: 16,
  /** How long a page waits for its report when the server names no time. */
  default_ttl_seconds: 30 * 60,
  /** The longest a server may ask a page to wait. */
  max_ttl_seconds: 24 * 60 * 60,
  /** How far a report's timestamp may be from Melete's clock. */
  report_tolerance_seconds: 5 * 60,
  /** The largest report body. */
  report_max_bytes: 16 * 1024,
  /** What a report's `summary` may hold. */
  summary_max_chars: 500,
  /** What the tool call's input and result handed to the page may weigh together. */
  handoff_max_bytes: 256 * 1024,
} as const;

export const connectionPageId = prefixedId(ID_PREFIXES.connection_page);

export const PAGE_STATES = ['open', 'completed', 'failed', 'cancelled', 'expired'] as const;
export const pageState = z.enum(PAGE_STATES);
export type PageState = z.infer<typeof pageState>;

/** What a server may report about its page. `expired` is Melete's alone to decide. */
export const pageReport = z
  .strictObject({
    status: z.enum(['completed', 'failed', 'cancelled']),
    /** One or two plain sentences the conversation reads: what happened. */
    summary: z.string().trim().min(1).max(PAGE_LIMITS.summary_max_chars),
    /** Anything the agent needs next (a reference, a total), as the server states it. */
    data: jsonObject.optional(),
  })
  .meta({ id: 'ConnectionPageReport' });
export type PageReport = z.infer<typeof pageReport>;

/** An `https:` origin, or `http://localhost` / `http://127.0.0.1` for development. */
export const pageOrigin = z
  .string()
  .max(300)
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    if (url.origin !== value) return false;
    // A plain host name or address: no wildcard, which a policy would read as many hosts.
    if (!/^([a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/i.test(url.hostname)) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  }, 'An origin is https://host[:port], or http://localhost[:port] for development');

/** A connection's page, as the person's conversation shows it. */
export const connectionPage = z
  .strictObject({
    id: connectionPageId,
    conversation_id: prefixedId(ID_PREFIXES.job),
    /** The connection's own name, as the person sees it in Connections. */
    connection_label: z.string().max(200),
    /** Where the connection's server is: shown beside the page, so nobody mistakes it for Melete. */
    connection_origin: z.string().max(300),
    state: pageState,
    created_at: timestamp,
    expires_at: timestamp,
    settled_at: timestamp.nullable(),
    /** The server's own words once it reported; Melete's when the page expired. */
    summary: z.string().max(PAGE_LIMITS.summary_max_chars).nullable(),
    /** Origins the page may ask Melete to open in a new tab, after the person agrees. */
    open_origins: z.array(z.string().max(300)).max(PAGE_LIMITS.domains_max),
  })
  .meta({ id: 'ConnectionPage' });
export type ConnectionPage = z.infer<typeof connectionPage>;

export const connectionPageList = z
  .strictObject({ pages: z.array(connectionPage).max(50) })
  .meta({ id: 'ConnectionPageList' });

/** A frame for one page, for the person whose conversation it is. */
export const connectionPageView = z
  .strictObject({
    /** Below the API's own address; framed by Melete, never opened on its own. */
    view_path: z.string().regex(/^\/pages\/view\/[A-Za-z0-9._-]+$/),
    expires_at: timestamp,
    /** The tool call's arguments and result, handed to the page as MCP Apps notifications. */
    tool_input: jsonObject,
    tool_result: jsonObject,
  })
  .meta({ id: 'ConnectionPageView' });
export type ConnectionPageView = z.infer<typeof connectionPageView>;

/* ---------- entitlements ---------- */

/**
 * The entitlements an operator can grant. The list is closed: a connection can
 * require only a name Melete knows, so a typo in a policy fails at install
 * rather than refusing every call.
 */
export const ENTITLEMENT_KEYS = ['verified'] as const;
export const entitlementKey = z.enum(ENTITLEMENT_KEYS);
export type EntitlementKey = z.infer<typeof entitlementKey>;

/** What the operator recorded with a grant; opaque to Melete. */
export const entitlementValue = z
  .strictObject({
    method: z.string().trim().min(1).max(100).optional(),
    level: z.string().trim().min(1).max(100).optional(),
  })
  .meta({ id: 'EntitlementValue' });

export const entitlementGrant = z
  .strictObject({
    key: entitlementKey,
    value: entitlementValue,
    granted_at: timestamp,
    /** Who granted it: an account id, or `operator` for the command line. */
    granted_by: z.string().max(100),
    /** Null for a grant that does not lapse. A lapsed grant counts for nothing. */
    expires_at: timestamp.nullable(),
  })
  .meta({ id: 'EntitlementGrant' });

/** What the operator sends to grant one. */
export const entitlementGrantInput = z
  .strictObject({ value: entitlementValue.optional(), expires_at: timestamp.nullable().optional() })
  .meta({ id: 'EntitlementGrantInput' });

export const entitlementList = z
  .strictObject({
    principal_id: prefixedId(ID_PREFIXES.owner),
    entitlements: z.array(entitlementGrant),
  })
  .meta({ id: 'EntitlementList' });
export type EntitlementList = z.infer<typeof entitlementList>;

/**
 * The claims of the identity assertion Melete hands a remote connection with
 * each tool call when the connection asks for one: a JWT signed with EdDSA
 * (Ed25519), sent in the `Melete-Identity` header, whose keys are published at
 * `/.well-known/jwks.json` below the installation's API.
 */
export const identityClaims = z.strictObject({
  /** The installation: its public address, or `melete` without one. */
  iss: z.string(),
  /** The connection's server: its endpoint's address, without query or trailing slash. */
  aud: z.string(),
  /**
   * The person the call is made for, as an id only this audience sees: the
   * same person gets a different `sub` at every server, and never an email.
   */
  sub: z.string().regex(/^p_[A-Za-z0-9_-]{22,64}$/),
  /** Every entitlement the person holds when the call is made. */
  ent: z.array(entitlementKey),
  /** The action this call carries out; one assertion per call. */
  jti: z.string(),
  /** The server's own name for the tool. */
  act: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type IdentityClaims = z.infer<typeof identityClaims>;
