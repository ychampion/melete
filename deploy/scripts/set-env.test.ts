import { expect, describe as group, test } from 'bun:test';
import { describe, isSecretName, requestedSettings, withSetting } from './set-env.ts';

group('the settings set-env writes', () => {
  test('NAME=value pairs, keeping an = inside the value', () => {
    expect(
      requestedSettings(['WEB_PORT=3201', 'MELETE_PUBLIC_URL=https://a.example/?x=1'], {}),
    ).toEqual([
      { name: 'WEB_PORT', value: '3201', secret: false },
      { name: 'MELETE_PUBLIC_URL', value: 'https://a.example/?x=1', secret: false },
    ]);
    expect(requestedSettings(['MELETE_IMAGE_TAG='], {})).toEqual([
      { name: 'MELETE_IMAGE_TAG', value: '', secret: false },
    ]);
  });

  test('a secret is refused on the command line, without echoing it', () => {
    for (const name of [
      'ELEVENLABS_API_KEY',
      'TS_AUTHKEY',
      'MELETE_BROWSER_TOKEN',
      'DATABASE_URL',
      'MELETE_SMTP_URL',
      'MELETE_ALERT_SMTP_URL',
      'MELETE_ALERT_WEBHOOK_URL',
      'MELETE_FEEDBACK_WEBHOOK_URL',
    ])
      expect(isSecretName(name)).toBe(true);
    try {
      requestedSettings(['ELEVENLABS_API_KEY=el-secret'], {});
      throw new Error('not refused');
    } catch (error) {
      expect((error as Error).message).toContain('--from-env ELEVENLABS_API_KEY');
      expect((error as Error).message).not.toContain('el-secret');
    }
  });

  test('--from-env reads the environment and refuses an empty or mistyped value', () => {
    expect(
      requestedSettings(['--from-env', 'ELEVENLABS_API_KEY'], { ELEVENLABS_API_KEY: ' el-1 ' }),
    ).toEqual([{ name: 'ELEVENLABS_API_KEY', value: 'el-1', secret: true }]);
    expect(() => requestedSettings(['--from-env', 'ELEVENLABS_API_KEY'], {})).toThrow('is empty');
    expect(() =>
      requestedSettings(['--from-env', 'ELEVENLABS_API_KEY'], { ELEVENLABS_API_KEY: 'a b' }),
    ).toThrow('space or a line break');
  });

  test('malformed arguments and line breaks are refused', () => {
    expect(() => requestedSettings([], {})).toThrow('Usage');
    expect(() => requestedSettings(['WEB_PORT'], {})).toThrow('is not NAME=value');
    expect(() => requestedSettings(['web_port=1'], {})).toThrow('is not NAME=value');
    expect(() => requestedSettings(['MELETE_PUBLIC_URL=a\nMELETE_MASTER_KEY=x'], {})).toThrow(
      'line break',
    );
  });

  test('MELETE_NETWORK_POOL is refused with the service rule, and what it takes is written', () => {
    for (const bad of ['10.214.0.0/25', '127.0.0.0/16', '10.214.0.1/16', 'none', 'fd00::/48']) {
      expect(() => requestedSettings([`MELETE_NETWORK_POOL=${bad}`], {})).toThrow(
        `MELETE_NETWORK_POOL is "${bad}"`,
      );
      expect(() =>
        requestedSettings(['--from-env', 'MELETE_NETWORK_POOL'], { MELETE_NETWORK_POOL: bad }),
      ).toThrow('nothing was changed');
    }
    for (const good of ['10.214.0.0/16', '10.0.0.0/8', '10.214.0.0/24', 'off', 'OFF', ''])
      expect(requestedSettings([`MELETE_NETWORK_POOL=${good}`], {})).toEqual([
        { name: 'MELETE_NETWORK_POOL', value: good, secret: false },
      ]);
    expect(requestedSettings(['--clear', 'MELETE_NETWORK_POOL'], {})[0]?.value).toBe('');
  });

  test('a secret is described by name only', () => {
    expect(describe({ name: 'ELEVENLABS_API_KEY', value: 'el-1', secret: true })).toBe(
      'Set ELEVENLABS_API_KEY.',
    );
    expect(describe({ name: 'WEB_PORT', value: '3201', secret: false })).toBe('Set WEB_PORT=3201.');
  });
});

group('rewriting deploy/.env', () => {
  const file = '# ports\nMELETE_PORT=3100\nWEB_PORT=3101\n# keep me\n';

  test('a setting is rewritten where it stands, comments and order kept', () => {
    expect(withSetting(file, 'WEB_PORT', '3201')).toBe(
      '# ports\nMELETE_PORT=3100\nWEB_PORT=3201\n# keep me\n',
    );
    expect(withSetting('export WEB_PORT = 1\n', 'WEB_PORT', '2')).toBe('WEB_PORT=2\n');
  });

  test('a missing setting is appended, and running it twice changes nothing more', () => {
    const once = withSetting('A=1', 'MELETE_SANDBOX_PROVIDER', 'docker');
    expect(once).toBe('A=1\nMELETE_SANDBOX_PROVIDER=docker\n');
    expect(withSetting(once, 'MELETE_SANDBOX_PROVIDER', 'docker')).toBe(once);
  });

  test('a value with $ is written as given', () => {
    expect(withSetting('X=1\n', 'X', 'a$&b')).toBe('X=a$&b\n');
  });

  test('a name is matched whole, not as the end of another', () => {
    expect(withSetting('MY_WEB_PORT=1\n', 'WEB_PORT', '2')).toBe('MY_WEB_PORT=1\nWEB_PORT=2\n');
  });

  test('a later line for the same name is dropped, since Compose would read it instead', () => {
    expect(withSetting('X=1\nA=2\n  export X=\n# X=3\nX=4', 'X', '5')).toBe('X=5\nA=2\n# X=3\n');
    expect(withSetting('A=1\nX=\r\nX=\r\n', 'X', '5')).toBe('A=1\nX=5\n');
  });
});
