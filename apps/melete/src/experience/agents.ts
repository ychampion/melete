import {
  agentInput,
  agentTemplateList,
  type ExperienceAgent,
  experienceAgent,
} from '@melete/contracts';
import { ServiceError } from '../api/errors.ts';
import type { agent } from '../db/schema.ts';

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
  ],
});

/**
 * The persona a conversation's agent adds on top of Melete's identity: a name,
 * a tone and a standing instruction. Melete's own identity and voice rules
 * reach every attempt whole; this only says who is speaking in this chat.
 * Bounded like the contract's `identity` field.
 */
export function agentIdentity(
  input: Pick<ExperienceAgent, 'name' | 'tone' | 'standing_instruction'>,
): string {
  const text = `In this conversation you are ${input.name}, one of the person's agents. Tone: ${input.tone}. Standing instruction: ${input.standing_instruction}`;
  if (text.length > 1000)
    throw new ServiceError('invalid_request', 'Keep the agent description shorter.', 400);
  return text;
}

export function agentView(
  row: typeof agent.$inferSelect,
  chats = 0,
  lastUsed: Date | null = null,
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
    ...(row.faceImage ? { face_image: row.faceImage } : {}),
    usage: { conversations: chats, last_used: lastUsed?.toISOString() ?? null },
  });
}

export function agentValues(raw: unknown) {
  const value = agentInput.parse(raw);
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
    faceImage: value.face_image ?? null,
  };
}
