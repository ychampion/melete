/**
 * Who handles a chat, as a picture: Melete is drawn with its mark, every other
 * agent with its own face. A chat whose agent is not known yet shows Melete.
 */
import { AgentFace, type FaceState } from '../design/face.tsx';
import { MeleteAvatar } from '../design/mark.tsx';
import { lookOf } from './hooks.ts';
import type { Agent } from './types.ts';

export function AgentAvatar({
  agent,
  size,
  state,
}: {
  agent: Agent | null;
  size: number;
  state?: FaceState;
}) {
  if (!agent || agent.is_default) return <MeleteAvatar size={size} />;
  return <AgentFace look={lookOf(agent)} size={size} {...(state ? { state } : {})} />;
}
