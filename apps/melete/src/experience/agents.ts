import { agentInput, type ExperienceAgent, experienceAgent } from '@melete/contracts';

export { mentionedAgent } from '@melete/contracts';
export { AGENT_TEMPLATES } from './agent-library.ts';

import { ServiceError } from '../api/errors.ts';
import type { agent } from '../db/schema.ts';

/**
 * Melete, the agent every space has. It reaches every connection the person
 * grants, now and later, the computer and memory, and it answers wherever no
 * other agent was chosen. Only its look, tone and standing instruction change.
 */
export const MELETE_AGENT = agentInput.parse({
  name: 'Melete',
  role: 'Your assistant',
  colour: '#2F5FD6',
  surface: 'rounded',
  eye_colour: '#14275C',
  tone: 'Warm and clear',
  standing_instruction: '',
  allowed_connection_ids: null,
  asks_before_acting: true,
  uses_computer: true,
  reads_memory: true,
  writes_memory: true,
});

/**
 * What an agent that keeps no memory is told, so it never says it will
 * remember something. Melete always keeps memory, so it is the one to offer.
 */
export const NO_MEMORY_NOTE =
  "You don't keep details from your chats. If the person asks you to remember something, don't say you will: tell them you don't keep details, and offer to have Melete remember it instead.";

/**
 * The persona a conversation's agent adds on top of Melete's identity: a name,
 * a tone and a standing instruction. Melete's own identity and voice rules
 * reach every attempt whole; this only says who is speaking in this chat.
 * Bounded like the contract's `identity` field.
 */
export function agentIdentity(
  input: Pick<ExperienceAgent, 'name' | 'tone' | 'standing_instruction'> & {
    is_default?: boolean;
    writes_memory?: boolean;
  },
): string {
  // Melete is already who answers; only what the person asked of it is added.
  const text = input.is_default
    ? `Tone: ${input.tone}.${input.standing_instruction ? ` Standing instruction: ${input.standing_instruction}` : ''}`
    : `In this conversation you are ${input.name}, one of the person's agents. Tone: ${input.tone}. Standing instruction: ${input.standing_instruction}${input.writes_memory === false ? ` ${NO_MEMORY_NOTE}` : ''}`;
  if (text.length > 1000)
    throw new ServiceError('invalid_request', 'Keep the agent description shorter.', 400);
  return text;
}

/**
 * The persona of a room's agent. It speaks for the room, never for any one
 * person in it, and it is told so, with the room's name.
 */
export function roomIdentity(
  input: Pick<ExperienceAgent, 'name' | 'tone' | 'standing_instruction'>,
  room: string,
): string {
  const text = `In this room you are ${input.name}, the agent of the room "${room}". Several people talk here; each message names who said it as a name and, in angle brackets, a short code the room gives that person. The code is that person's alone and tells people apart; the name before it is one they chose for themselves, and two people may choose names that look alike. You act for the room, never as any one person, and you use only what the room has. Tone: ${input.tone}. Standing instruction: ${input.standing_instruction}`;
  return text.length > 1000 ? `${text.slice(0, 999)}…` : text;
}

export function agentView(
  row: typeof agent.$inferSelect,
  chats = 0,
  lastUsed: Date | null = null,
  sharedSpace = false,
  routines = 0,
): ExperienceAgent {
  return experienceAgent.parse({
    id: row.id,
    space_id: row.spaceId,
    name: row.name,
    role: row.role,
    colour: row.colour,
    surface: row.surface,
    eye_colour: row.eyeColour,
    tone: row.tone,
    standing_instruction: row.standingInstruction,
    allowed_connection_ids: row.allowedConnectionIds,
    asks_before_acting: row.asksBeforeActing,
    uses_computer: row.usesComputer,
    reads_memory: row.readsMemory,
    writes_memory: row.writesMemory,
    is_default: row.isDefault,
    fixed_reach: row.isDefault && !sharedSpace,
    ...(row.faceImage ? { face_image: row.faceImage } : {}),
    usage: { conversations: chats, last_used: lastUsed?.toISOString() ?? null, routines },
  });
}

/**
 * What a save may store. Melete always keeps its name. In a personal space it
 * also keeps its reach (every connection, the computer and memory), so an edit
 * may change how it looks and sounds, never what it can use. In a shared space
 * its owner chooses what it may use, as for any other agent.
 */
export function agentValues(raw: unknown, isDefault = false, fixedReach = isDefault) {
  const value = agentInput.parse(raw);
  if (isDefault && value.name !== MELETE_AGENT.name)
    throw new ServiceError('default_agent_fixed', 'Melete keeps its name.', 400);
  if (
    fixedReach &&
    (value.allowed_connection_ids !== null ||
      !value.uses_computer ||
      !value.reads_memory ||
      !value.writes_memory)
  )
    throw new ServiceError(
      'default_agent_fixed',
      'Melete can use everything you connect. Make a new agent to narrow what it can use.',
      400,
    );
  agentIdentity(value);
  return {
    name: value.name,
    role: value.role,
    colour: value.colour,
    surface: value.surface,
    eyeColour: value.eye_colour,
    tone: value.tone,
    standingInstruction: value.standing_instruction,
    allowedConnectionIds: value.allowed_connection_ids,
    asksBeforeActing: value.asks_before_acting,
    usesComputer: value.uses_computer,
    readsMemory: value.reads_memory,
    writesMemory: value.writes_memory,
    faceImage: value.face_image ?? null,
  };
}
