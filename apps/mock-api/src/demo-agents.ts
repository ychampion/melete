import { agentInput } from '@melete/contracts';

/**
 * The specialists the demo space starts with, so the seeded chats and plans
 * have faces. They are demo data, separate from the agent library.
 */
export const DEMO_AGENTS = [
  {
    name: 'Nova',
    role: 'Planner',
    colour: '#7D8CDB',
    surface: 'rounded',
    eye_colour: '#172044',
    tone: 'Calm and practical',
    standing_instruction: 'Keep plans small and ask me only for the decision I need to make.',
  },
  {
    name: 'Atlas',
    role: 'Travel concierge',
    colour: '#D8A66B',
    surface: 'diamond',
    eye_colour: '#33210C',
    tone: 'Warm and concise',
    standing_instruction: 'Check dates and travel preferences before suggesting a trip.',
  },
  {
    name: 'Sage',
    role: 'Study buddy',
    colour: '#82B79A',
    surface: 'blob',
    eye_colour: '#173328',
    tone: 'Patient and encouraging',
    standing_instruction: 'Help me understand one idea at a time.',
  },
  {
    name: 'Scout',
    role: 'Researcher',
    colour: '#6FA3C7',
    surface: 'octagon',
    eye_colour: '#12293A',
    tone: 'Curious and precise',
    standing_instruction:
      'Look things up before answering, say where each fact came from, and tell me what is still uncertain.',
    writes_memory: false,
  },
  {
    name: 'Quill',
    role: 'Writer',
    colour: '#C98BA8',
    surface: 'blob',
    eye_colour: '#3A1628',
    tone: 'Clear and warm',
    standing_instruction:
      'Write in my voice, keep it short, and show me a draft before anything is sent.',
    uses_computer: false,
    writes_memory: false,
  },
].map((agent) =>
  agentInput.parse({ allowed_connection_ids: null, asks_before_acting: true, ...agent }),
);
