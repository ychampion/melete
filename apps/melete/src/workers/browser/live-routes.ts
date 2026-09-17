import type { BrowserLive } from './live.ts';
import {
  liveCloseRequest,
  liveOpenRequest,
  livePullRequest,
  liveScopeRequest,
  liveUp,
} from './live-protocol.ts';

/**
 * The worker side of a person's live channel, behind the worker token and its refusal of
 * browser-originated requests. Bodies parse into typed page input; no browser protocol method,
 * script or selector is accepted. An unknown path answers undefined so the listener returns 404.
 */
export function liveRoutes(live: BrowserLive) {
  return async (path: string, body: unknown): Promise<unknown> => {
    if (path === '/live/open') {
      const request = liveOpenRequest.parse(body);
      return live.open(request.session_id, request.control_epoch);
    }
    if (path === '/live/pull') {
      const request = livePullRequest.parse(body);
      return live.pull(request.live_id, request.ack_through, request.timeout_ms);
    }
    if (path === '/live/input') {
      const request = liveUp.parse(body);
      return live.input(request.live_id, request.ack_through, request.events);
    }
    if (path === '/live/scope') {
      const request = liveScopeRequest.parse(body);
      return live.allow(request.live_id, request.host);
    }
    if (path === '/live/close') return live.close(liveCloseRequest.parse(body).live_id);
    return undefined;
  };
}
