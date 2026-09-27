/**
 * Who an MCP tool call acts for, carried to the owner API's own routes.
 *
 * A tool call is answered by calling the same route a signed-in person would,
 * in this process, with the person the access token names. The person rides
 * on the request's environment under a symbol only this module holds: a
 * request from the network gets its environment from the listener, which
 * never sets it, so no header, cookie or body can claim to be an assistant's
 * person.
 */
export const MCP_ACTOR: unique symbol = Symbol('melete.mcp-actor');

export type McpActor = {
  principalId: string;
  spaceId: string;
  membershipGeneration: number | null;
  /** The assistant, by name, for anything shown to the person about what it asked. */
  clientName: string;
};

export function mcpActorOf(env: unknown): McpActor | undefined {
  if (env === null || typeof env !== 'object') return undefined;
  const actor = (env as { [MCP_ACTOR]?: McpActor })[MCP_ACTOR];
  return actor && typeof actor.principalId === 'string' ? actor : undefined;
}

/** The environment an in-process request carries for one actor. */
export const actorEnvironment = (actor: McpActor) => ({ [MCP_ACTOR]: actor });

/** Paths the auth middleware lets through without a session; each route decides for itself. */
export const MCP_PUBLIC_PATHS: { get: readonly string[]; post: readonly string[]; mcp: string } = {
  get: [
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/api/mcp',
    '/oauth/authorize',
  ],
  post: ['/oauth/authorize', '/oauth/register', '/oauth/token', '/oauth/revoke'],
  /** Answered by a bearer token rather than a session. */
  mcp: '/mcp',
};

/** Whether a request is for one of the routes above, which answer without a session. */
export const mcpPublicPath = (method: string, path: string): boolean =>
  path === MCP_PUBLIC_PATHS.mcp ||
  (method === 'GET' && MCP_PUBLIC_PATHS.get.includes(path)) ||
  (method === 'POST' && MCP_PUBLIC_PATHS.post.includes(path));

/** Owner commands an assistant started carry this prefix, so nothing admits them on standing permission. */
export const MCP_COMMAND_PREFIX = 'mcp:';
