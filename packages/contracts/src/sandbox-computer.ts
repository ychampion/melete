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
    viewport: z.strictObject({
      width: z.literal(LIVE_VIEWPORT.width),
      height: z.literal(LIVE_VIEWPORT.height),
    }),
    egress: z.enum(['deny_all', 'connected_hosts_only', 'open']),
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
