import { describe, expect, test } from 'bun:test';
import { type AttemptBundle, EMPTY_SINCE_LAST, REPLY_VOICES } from '@melete/contracts';
import { estimateTokens, IDENTITY_MAX_TOKENS, loadIdentity } from '@melete/skills';
import { HermesClient } from './client.ts';
import { renderInstructions, renderSoul, renderVoice, VOICE_LINES } from './instructions.ts';

const SUFFIX = '01J8ZP3QWABCDEFGHJKMNPQRST';
const bundle: AttemptBundle = {
  attempt: { id: `att_${SUFFIX}`, job_id: `job_${SUFFIX}`, epoch: 1, revision: 1, token: 't' },
  job: {
    title: 'Write to the landlord',
    objective: 'Draft a note about the leak.',
    constraints: {},
    progress_summary: '',
    unresolved_questions: [],
    deliverable: {},
  },
  inputs: {
    new_user_messages: [{ role: 'user', content: 'draft it', at: '2026-10-01T00:00:00.000Z' }],
    approval_results: [],
    trigger_events: [],
    repair_briefs: [],
  },
  since_last: EMPTY_SINCE_LAST,
  transcript: [],
  tools: [],
  skills: [],
  knowledge: [],
  workspace: { mount: '/work', files: [] },
  budget: { max_turns: 8, max_output_tokens: 4000, max_wall_ms: 120000, max_actions: 3 },
  model: { provider: 'fireworks', model: 'deepseek-v4p1-flash', fallback: null },
};

describe('the voice the person picked', () => {
  test('reaches the run instructions, one voice at a time', () => {
    for (const voice of REPLY_VOICES) {
      const instructions = renderInstructions({ ...bundle, voice });
      expect(instructions).toContain('# How you sound');
      expect(instructions).toContain(VOICE_LINES[voice]);
      for (const other of REPLY_VOICES.filter((name) => name !== voice))
        expect(instructions).not.toContain(VOICE_LINES[other]);
    }
  });

  test('reaches the request the engine is sent', () => {
    const client = new HermesClient({ baseUrl: 'http://runtime:8790/', token: 'surrogate' });
    const body = JSON.stringify(client.startRun({ ...bundle, voice: 'professional' }).body);
    expect(body).toContain(VOICE_LINES.professional);
  });

  test('is teammate when none was picked, the way Melete has always talked', () => {
    const instructions = renderInstructions(bundle);
    expect(instructions).toContain(VOICE_LINES.teammate);
    expect(VOICE_LINES.teammate).toContain('contractions welcome');
  });

  test('a draft leans to its reader: professional to a client, whatever the voice', () => {
    for (const voice of REPLY_VOICES) {
      const block = renderVoice(voice).replace(/\s+/g, ' ');
      expect(block).toContain('When you write for someone else');
      expect(block).toContain('to a client, customer, landlord, employer, office');
      expect(block).toContain('sound professional whatever your voice');
      expect(block).toContain('A tone the person asks for ("more casual", "more formal") wins');
    }
  });

  test('asks for prose first and no dashes, in a block that costs little', () => {
    for (const voice of REPLY_VOICES) {
      const block = renderVoice(voice);
      expect(block).toContain('Prose first');
      expect(block).toContain('no headings or bold in a short reply');
      expect(block).toContain('never em dashes');
      expect(estimateTokens(block)).toBeLessThanOrEqual(160);
      // The block's own words follow its rules.
      expect(block).not.toMatch(/[—–]/);
    }
  });

  test('stays out of the identity, which keeps its cap', () => {
    const identity = loadIdentity();
    expect(estimateTokens(identity)).toBeLessThanOrEqual(IDENTITY_MAX_TOKENS);
    expect(renderSoul()).not.toContain('# How you sound');
    expect(identity).not.toContain('teammate');
  });
});
