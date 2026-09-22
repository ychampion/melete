import { describe, expect, test } from 'bun:test';
import { SKILL_TRACE_KIND, skillTraceCall } from './skill-trace.ts';

const at = new Date('2026-09-23T10:00:00Z');

describe('the skills an attempt follows are shown as one tool entry', () => {
  test('names each skill in plain words, and never carries its instructions', () => {
    const call = skillTraceCall(
      'att_1',
      [
        { name: 'research-with-sources', body: 'Fetch a page before citing it.' },
        { name: 'draft-follow-up', body: 'Read the thread before writing.' },
      ],
      at,
    );
    expect(SKILL_TRACE_KIND).toBe('tool_trace');
    expect(call).toEqual({
      id: 'skills:att_1',
      kind: 'skill',
      title: 'Followed 2 ways of working',
      status: 'done',
      started_at: at.toISOString(),
      ended_at: at.toISOString(),
      input_summary: null,
      output_summary: { text: 'Research with sources, Draft follow up' },
      detail: null,
      parent: null,
    });
    expect(JSON.stringify(call)).not.toContain('Fetch a page');
  });

  test('one skill is named in the title, and a learned procedure is called what it is', () => {
    expect(
      skillTraceCall('att_2', [{ name: 'plan-a-responsibility', body: 'x' }], at),
    ).toMatchObject({
      title: 'Followed the skill: Plan a responsibility',
      output_summary: { text: 'Plan a responsibility' },
    });
    expect(
      skillTraceCall(
        'att_3',
        [{ name: 'procedure:prc_01J00000000000000000000000', body: 'x' }],
        at,
      ),
    ).toMatchObject({ title: 'Followed a way of working you showed me' });
  });

  test('an attempt with no skills has no entry', () => {
    expect(skillTraceCall('att_4', [], at)).toBeNull();
  });
});
