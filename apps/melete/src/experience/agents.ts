import {
  agentInput,
  agentTemplateList,
  type ExperienceAgent,
  experienceAgent,
} from '@melete/contracts';

export { mentionedAgent } from '@melete/contracts';

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

export const AGENT_TEMPLATES = agentTemplateList.parse({
  templates: [
    {
      id: 'planner',
      title: 'Planner',
      agent: {
        name: 'Nova',
        role: 'Planner',
        colour: '#7D8CDB',
        surface: 'rounded',
        eye_colour: '#172044',
        tone: 'Calm and practical',
        standing_instruction: 'Keep plans small and ask me only for the decision I need to make.',
        allowed_connection_ids: null,
        asks_before_acting: true,
      },
    },
    {
      id: 'travel',
      title: 'Travel concierge',
      agent: {
        name: 'Atlas',
        role: 'Travel concierge',
        colour: '#D8A66B',
        surface: 'diamond',
        eye_colour: '#33210C',
        tone: 'Warm and concise',
        standing_instruction: 'Check dates and travel preferences before suggesting a trip.',
        allowed_connection_ids: null,
        asks_before_acting: true,
      },
    },
    {
      id: 'study',
      title: 'Study buddy',
      agent: {
        name: 'Sage',
        role: 'Study buddy',
        colour: '#82B79A',
        surface: 'blob',
        eye_colour: '#173328',
        tone: 'Patient and encouraging',
        standing_instruction: 'Help me understand one idea at a time.',
        allowed_connection_ids: null,
        asks_before_acting: true,
      },
    },
    {
      id: 'researcher',
      title: 'Researcher',
      agent: {
        name: 'Scout',
        role: 'Researcher',
        colour: '#6FA3C7',
        surface: 'octagon',
        eye_colour: '#12293A',
        tone: 'Curious and precise',
        standing_instruction:
          'Look things up before answering, say where each fact came from, and tell me what is still uncertain.',
        allowed_connection_ids: null,
        asks_before_acting: true,
        uses_computer: true,
        reads_memory: true,
        writes_memory: false,
      },
    },
    {
      id: 'writer',
      title: 'Writer',
      agent: {
        name: 'Quill',
        role: 'Writer',
        colour: '#C98BA8',
        surface: 'blob',
        eye_colour: '#3A1628',
        tone: 'Clear and warm',
        standing_instruction:
          'Write in my voice, keep it short, and show me a draft before anything is sent.',
        allowed_connection_ids: null,
        asks_before_acting: true,
        uses_computer: false,
        reads_memory: true,
        writes_memory: false,
      },
    },
  ],
});

/**
 * The persona a conversation's agent adds on top of Melete's identity: a name,
 * a tone and a standing instruction. Melete's own identity and voice rules
 * reach every attempt whole; this only says who is speaking in this chat.
 * Bounded like the contract's `identity` field.
 */
export function agentIdentity(
  input: Pick<ExperienceAgent, 'name' | 'tone' | 'standing_instruction'> & {
    is_default?: boolean;
  },
): string {
  // Melete is already who answers; only what the person asked of it is added.
  const text = input.is_default
    ? `Tone: ${input.tone}.${input.standing_instruction ? ` Standing instruction: ${input.standing_instruction}` : ''}`
    : `In this conversation you are ${input.name}, one of the person's agents. Tone: ${input.tone}. Standing instruction: ${input.standing_instruction}`;
  if (text.length > 1000)
    throw new ServiceError('invalid_request', 'Keep the agent description shorter.', 400);
  return text;
}

export function agentView(
  row: typeof agent.$inferSelect,
  chats = 0,
  lastUsed: Date | null = null,
  sharedSpace = false,
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
    usage: { conversations: chats, last_used: lastUsed?.toISOString() ?? null },
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
