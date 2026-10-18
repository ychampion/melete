/**
 * The desktop inside an agent's sandbox, as a person sees it: which computer a
 * job has, who is driving it, and the control changes. Watching it and sending
 * input use the same live wire shapes as the browser worker (`LiveOpen`, the
 * `LiveDown` frame stream and `LiveUp` input), so one panel can draw both.
 */
import { z } from 'zod';
import { LIVE_VIEWPORT } from './browser-live.ts';

export const sandboxControl = z.enum(['agent', 'human']);
export type SandboxControl = z.infer<typeof sandboxControl>;

export const sandboxComputer = z
  .strictObject({
    /** The sandbox session the routes below take. */
    session_id: z.string(),
    job_id: z.string().nullable(),
    agent_id: z.string().nullable(),
    /** `ready` while an attempt holds it; `paused` between attempts, kept for the agent. */
    status: z.enum(['ready', 'paused']),
    /** Whether the container is running now. A stopped one starts again when it is used. */
    running: z.boolean(),
    control: sandboxControl,
    control_epoch: z.number().int().nonnegative(),
    /** The desktop's screen: the live view's for Melete's own desktop, the provider's otherwise. */
    viewport: z.strictObject({
      width: z
        .number()
        .int()
        .positive()
        .max(LIVE_VIEWPORT.width * 4),
      height: z
        .number()
        .int()
        .positive()
        .max(LIVE_VIEWPORT.height * 4),
    }),
    egress: z.enum(['deny_all', 'connected_hosts_only', 'open']),
    /**
     * How a person sees and steers it: `stream`, through this API's live view;
     * `link`, through the provider's own viewer, opened from a short-lived
     * link that is asked for each time (`SandboxViewerRequest`).
     */
    view: z.enum(['stream', 'link']),
  })
  .meta({ id: 'SandboxComputer' });
export type SandboxComputer = z.infer<typeof sandboxComputer>;

export const sandboxComputerList = z
  .strictObject({ computers: z.array(sandboxComputer).max(16) })
  .meta({ id: 'SandboxComputerList' });
export type SandboxComputerList = z.infer<typeof sandboxComputerList>;

export const sandboxComputerQuery = z.object({ job_id: z.string().min(1).max(64) });

/**
 * The epoch the person last saw. Given, control changes only from that epoch,
 * so a page showing an older state is refused with 409 rather than acting on
 * a computer that changed hands since.
 */
export const sandboxControlRequest = z
  .strictObject({ control_epoch: z.number().int().nonnegative().optional() })
  .meta({ id: 'SandboxControlRequest' });
export type SandboxControlRequest = z.infer<typeof sandboxControlRequest>;

export const sandboxControlResponse = z
  .strictObject({
    session_id: z.string(),
    control: sandboxControl,
    control_epoch: z.number().int().nonnegative(),
  })
  .meta({ id: 'SandboxControlResponse' });
export type SandboxControlResponse = z.infer<typeof sandboxControlResponse>;

/**
 * A link to a desktop shown through its provider's own viewer: `watch` to look
 * on, `control` to drive it while you hold it. Asked for each time it is
 * opened and never kept: it is a credential for that computer until it expires.
 */
export const sandboxViewerRequest = z
  .strictObject({ mode: z.enum(['watch', 'control']) })
  .meta({ id: 'SandboxViewerRequest' });
export type SandboxViewerRequest = z.infer<typeof sandboxViewerRequest>;

export const sandboxViewerResponse = z
  .strictObject({
    mode: z.enum(['watch', 'control']),
    url: z.string().url().max(4096),
    /** When the link stops working; empty when the provider did not say. */
    expires_at: z.string().max(64),
  })
  .meta({ id: 'SandboxViewerResponse' });
export type SandboxViewerResponse = z.infer<typeof sandboxViewerResponse>;
