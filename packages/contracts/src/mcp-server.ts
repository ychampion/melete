/**
 * Melete as an MCP server: the OAuth documents and bodies an assistant uses to
 * connect, and the list a person sees of the assistants they let in.
 */
import { z } from 'zod';

/** RFC 8414 authorization server metadata. */
export const oauthServerMetadata = z.object({
  issuer: z.url(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  registration_endpoint: z.url(),
  revocation_endpoint: z.url(),
  response_types_supported: z.array(z.string()),
  response_modes_supported: z.array(z.string()),
  grant_types_supported: z.array(z.string()),
  code_challenge_methods_supported: z.array(z.string()),
  token_endpoint_auth_methods_supported: z.array(z.string()),
  revocation_endpoint_auth_methods_supported: z.array(z.string()),
  scopes_supported: z.array(z.string()),
  client_id_metadata_document_supported: z.boolean(),
  authorization_response_iss_parameter_supported: z.boolean(),
});

/** RFC 9728 protected resource metadata for the MCP endpoint. */
export const oauthProtectedResource = z.object({
  resource: z.url(),
  authorization_servers: z.array(z.url()),
  scopes_supported: z.array(z.string()),
  bearer_methods_supported: z.array(z.string()),
  resource_name: z.string(),
});

/** RFC 7591 registration of a public client. */
export const oauthClientRegistration = z
  .object({
    redirect_uris: z.array(z.string()).min(1).max(10),
    client_name: z.string().max(120).optional(),
    token_endpoint_auth_method: z.literal('none').optional(),
    grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).optional(),
    response_types: z.array(z.literal('code')).optional(),
    scope: z.string().max(500).optional(),
  })
  .loose();

export const oauthClientRegistered = z.object({
  client_id: z.string(),
  client_id_issued_at: z.number().int(),
  client_name: z.string(),
  redirect_uris: z.array(z.string()),
  token_endpoint_auth_method: z.literal('none'),
  grant_types: z.array(z.string()),
  response_types: z.array(z.string()),
});

/** The token endpoint's form body: the code grant with its PKCE verifier, or a refresh. */
export const oauthTokenRequest = z.object({
  grant_type: z.enum(['authorization_code', 'refresh_token']),
  client_id: z.string(),
  code: z.string().optional(),
  redirect_uri: z.string().optional(),
  code_verifier: z.string().optional(),
  refresh_token: z.string().optional(),
  resource: z.string().optional(),
});

export const oauthTokenResponse = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int(),
  refresh_token: z.string(),
  scope: z.string(),
});

export const oauthErrorResponse = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

/** The query an assistant sends a person to the consent page with. */
export const oauthAuthorizeQuery = z.object({
  response_type: z.literal('code'),
  client_id: z.string(),
  redirect_uri: z.string(),
  code_challenge: z.string(),
  code_challenge_method: z.literal('S256'),
  state: z.string().optional(),
  scope: z.string().optional(),
  resource: z.string().optional(),
});

/** The consent form the page posts back, carrying the same request and the person's answer. */
export const oauthConsentForm = oauthAuthorizeQuery.extend({
  consent: z.string(),
  decision: z.enum(['allow', 'deny']),
});

/** One JSON-RPC 2.0 message to the MCP endpoint. */
export const mcpRpcMessage = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const mcpRpcResponse = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number().int(), message: z.string() }).optional(),
});

/** An assistant the person let in, while it still holds a live token. */
export const mcpConnectedClient = z.object({
  client_id: z.string(),
  name: z.string(),
  since: z.iso.datetime(),
});

export const mcpConnectedClientList = z.object({ clients: z.array(mcpConnectedClient) });
