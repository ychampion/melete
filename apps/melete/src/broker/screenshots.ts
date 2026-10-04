/**
 * A screenshot's picture, read back for whoever may see it: the runtime of the
 * job that took it (through the broker), and the person whose work it was
 * (`GET /screenshots/{id}`).
 *
 * The agent's own computer's is in the job's workspace, at the path its
 * receipt names. A paired computer's is in the service's own store
 * (devices/screens.ts). Either is served only while it is a PNG and the very
 * picture the receipt recorded: a workspace file the agent rewrote since is
 * not the screenshot it claims to be.
 */
import { createHash } from 'node:crypto';
import { readDeviceScreen } from '../devices/screens.ts';
import { readWorkspaceFile } from '../sandbox/workspace.ts';

/**
 * The agent's own computer's tools whose succeeded receipts may carry a
 * screenshot: looking, and every step that ends with one.
 */
export const OWN_COMPUTER_PICTURE_TOOLS: readonly string[] = [
  'computer.screenshot',
  'computer.open',
  'computer.click',
  'computer.type',
  'computer.key',
  'computer.scroll',
  'computer.batch',
];

/** The tools whose succeeded receipts stand for a screenshot. */
export const SCREENSHOT_TOOLS: readonly string[] = [
  ...OWN_COMPUTER_PICTURE_TOOLS,
  'device.screenshot',
  'device.browser_screenshot',
];

/** The eight bytes every PNG file starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The largest saved screenshot read back: a device's own cap is 8 MB. */
export const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;

/** A succeeded screenshot action, as far as reading its picture goes. */
export type ScreenshotAction = {
  id: string;
  job_id: string;
  kind: string;
  status: string;
  receipt: { detail?: unknown } | null | undefined;
};

/** The picture, or null when this action has none that can be shown. */
export async function readScreenshot(
  workRoot: string,
  action: ScreenshotAction,
): Promise<Buffer | null> {
  if (!SCREENSHOT_TOOLS.includes(action.kind) || action.status !== 'succeeded') return null;
  const detail = (action.receipt?.detail ?? {}) as Record<string, unknown>;
  const own = OWN_COMPUTER_PICTURE_TOOLS.includes(action.kind);
  const recorded = own ? detail.sha256 : detail.content_hash;
  if (typeof recorded !== 'string') return null;
  let bytes: Buffer;
  try {
    if (own) {
      if (typeof detail.path !== 'string' || !detail.path.toLowerCase().endsWith('.png'))
        return null;
      bytes = await readWorkspaceFile(workRoot, action.job_id, detail.path, MAX_SCREENSHOT_BYTES);
    } else {
      bytes = await readDeviceScreen(workRoot, action.job_id, action.id, MAX_SCREENSHOT_BYTES);
    }
  } catch {
    return null;
  }
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (createHash('sha256').update(bytes).digest('hex') !== recorded) return null;
  return bytes;
}
