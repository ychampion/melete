import { describe, expect, test } from 'bun:test';
import { type ModelGuidance, modelGuidance } from '@melete/contracts';
import { withTemplateKwargs } from './effort.ts';

const NEMOTRON = 'nvidia/nemotron-3-super-120b-a12b';

/** Runs `check` with the Nemotron entry's template switch set, then puts it back. */
function withSwitch(kwargs: Record<string, unknown>, check: () => void) {
  const entry = modelGuidance(NEMOTRON) as ModelGuidance;
  const before = entry.chat_template_kwargs;
  entry.chat_template_kwargs = kwargs;
  try {
    check();
  } finally {
    if (before === undefined) delete entry.chat_template_kwargs;
    else entry.chat_template_kwargs = before;
  }
}

describe('a model family’s chat template arguments', () => {
  test('nothing is sent while the family sets none', () => {
    expect(withTemplateKwargs({}, { protocol: 'chat/completions', model: NEMOTRON })).toEqual({});
  });

  test('a family that sets them has them on chat completions only', () => {
    withSwitch({ enable_thinking: false }, () => {
      expect(withTemplateKwargs({}, { protocol: 'chat/completions', model: NEMOTRON })).toEqual({
        chat_template_kwargs: { enable_thinking: false },
      });
      expect(withTemplateKwargs({}, { protocol: 'responses', model: NEMOTRON })).toEqual({});
      expect(withTemplateKwargs({}, { protocol: 'chat/completions', model: 'gpt-6' })).toEqual({});
    });
  });

  test('a request that names its own keeps them', () => {
    withSwitch({ enable_thinking: false }, () => {
      const own = { chat_template_kwargs: { enable_thinking: true } };
      expect(withTemplateKwargs(own, { protocol: 'chat/completions', model: NEMOTRON })).toEqual({
        chat_template_kwargs: { enable_thinking: true },
      });
    });
  });
});
