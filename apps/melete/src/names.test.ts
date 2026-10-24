/**
 * The names the service writes into words a person reads, and the sentences
 * built from them once, at start.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { LOST_NOTE } from './jobs/runner.ts';
import { assistantName, instanceName } from './names.ts';

const saved = {
  assistant: process.env.MELETE_ASSISTANT_NAME,
  instance: process.env.MELETE_INSTANCE_NAME,
};
const put = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};
afterEach(() => {
  put('MELETE_ASSISTANT_NAME', saved.assistant);
  put('MELETE_INSTANCE_NAME', saved.instance);
});

describe('the installation’s names', () => {
  test('both are Melete when neither is set', () => {
    put('MELETE_ASSISTANT_NAME', undefined);
    put('MELETE_INSTANCE_NAME', '');
    expect([assistantName(), instanceName()]).toEqual(['Melete', 'Melete']);
  });

  test('with only the installation named, the assistant takes its name', () => {
    put('MELETE_INSTANCE_NAME', 'Riverside Assistant');
    put('MELETE_ASSISTANT_NAME', '');
    expect(assistantName()).toBe('Riverside Assistant');
    put('MELETE_ASSISTANT_NAME', 'Juniper');
    expect([assistantName(), instanceName()]).toEqual(['Juniper', 'Riverside Assistant']);
  });

  test('a sentence built from a name says the name, not the code that reads it', () => {
    expect(LOST_NOTE).not.toContain('${');
    expect(LOST_NOTE).toContain(`because ${instanceName()} restarted`);
  });
});
