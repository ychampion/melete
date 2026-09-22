import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvFile, providerWarnings } from './provider-settings.ts';

const template = readFileSync(join(import.meta.dir, '..', '.env.example'), 'utf8');

describe('what configure.ts tells an operator about the provider it wrote', () => {
  test('the example configuration selects a real provider and leaves its key empty', () => {
    const warnings = providerWarnings(parseEnvFile(template));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('MELETE_DEFAULT_PROVIDER=fireworks');
    expect(warnings[0]).toContain('FIREWORKS_API_KEY');
    expect(warnings[0]).toContain('deploy/.env');
  });

  test('a filled key, or the explicit fake provider, needs no warning', () => {
    expect(providerWarnings({ ...parseEnvFile(template), FIREWORKS_API_KEY: 'fw_key' })).toEqual(
      [],
    );
    expect(
      providerWarnings({
        ...parseEnvFile(template),
        MELETE_DEFAULT_PROVIDER: 'fake',
        MELETE_DEFAULT_MODEL: 'scripted',
        MELETE_ENABLE_FAKE_PROVIDER: 'true',
      }),
    ).toEqual([]);
  });

  test('the fake provider without its switch is called out', () => {
    expect(
      providerWarnings({
        MELETE_DEFAULT_PROVIDER: 'fake',
        MELETE_ENABLE_FAKE_PROVIDER: 'false',
      })[0],
    ).toContain('MELETE_ENABLE_FAKE_PROVIDER=true');
  });

  test('an OpenAI-compatible endpoint needs the exact name, an address and a key', () => {
    expect(providerWarnings({ MELETE_DEFAULT_PROVIDER: 'openai-compat' })[0]).toContain(
      'openai-compatible',
    );
    const unset = providerWarnings({ MELETE_DEFAULT_PROVIDER: 'openai-compatible' });
    expect(unset.join('\n')).toContain('OPENAI_COMPAT_BASE_URL');
    expect(unset.join('\n')).toContain('OPENAI_COMPAT_API_KEY');
    expect(
      providerWarnings({
        MELETE_DEFAULT_PROVIDER: 'openai-compatible',
        OPENAI_COMPAT_BASE_URL: 'https://models.example.net/v1',
        OPENAI_API_KEY: 'shared',
      }),
    ).toEqual([]);
    expect(
      providerWarnings({
        MELETE_DEFAULT_PROVIDER: 'openai-compatible',
        OPENAI_COMPAT_BASE_URL: 'http://192.168.1.20:11434/v1',
        OPENAI_COMPAT_API_KEY: 'local',
      }),
    ).toEqual([]);
  });

  test('a plain HTTP endpoint is not satisfied by the OpenAI key', () => {
    const warnings = providerWarnings({
      MELETE_DEFAULT_PROVIDER: 'openai-compatible',
      OPENAI_COMPAT_BASE_URL: 'http://192.168.1.20:11434/v1',
      OPENAI_API_KEY: 'shared',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('OPENAI_COMPAT_API_KEY is empty');
    expect(warnings[0]).toContain('never sent to a plain http:// endpoint');
  });

  test('reads an env file the way Compose does for plain values', () => {
    expect(
      parseEnvFile('# A=comment\nA=1\n\nB = spaced \nC="quoted value"\nD=\nexport E=5\r\n'),
    ).toEqual({ A: '1', B: 'spaced', C: 'quoted value', D: '', E: '5' });
  });
});

describe('reading deploy/.env the way Compose does', () => {
  test('an inline comment on an unquoted value is not part of it', () => {
    const values = parseEnvFile(
      [
        'OPENAI_API_KEY=sk-live-value # the team key',
        'POSTGRES_PASSWORD=pa#ss # a hash inside a word stays',
        'TS_HOSTNAME=#melete',
        'MELETE_DEFAULT_PROVIDER=openai   ',
        'export ANTHROPIC_API_KEY=ak-value',
        '# FIREWORKS_API_KEY=commented-out',
      ].join('\n'),
    );
    expect(values).toEqual({
      OPENAI_API_KEY: 'sk-live-value',
      POSTGRES_PASSWORD: 'pa#ss',
      TS_HOSTNAME: '#melete',
      MELETE_DEFAULT_PROVIDER: 'openai',
      ANTHROPIC_API_KEY: 'ak-value',
    });
  });

  test('a quoted value ends at its closing quote, comment or not', () => {
    const values = parseEnvFile(
      ['A="value # kept" # dropped', "B='single # kept' # dropped", 'C="say \\"hi\\""', 'D='].join(
        '\r\n',
      ),
    );
    expect(values).toEqual({ A: 'value # kept', B: 'single # kept', C: 'say "hi"', D: '' });
  });

  test('$$ is one $ unquoted and in double quotes, and two in single quotes', () => {
    // Redaction replaces the value Compose hands the service, so it has to be that value.
    const values = parseEnvFile(
      ['A=pa$$word', 'B="pa$$word"', "C='pa$$word'", 'D=pa$$$$word # two'].join('\n'),
    );
    expect(values).toEqual({ A: 'pa$word', B: 'pa$word', C: 'pa$$word', D: 'pa$$word' });
  });
});
