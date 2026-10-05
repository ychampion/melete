import { describe, expect, test } from 'bun:test';
import { reviewTier } from './auto-review.ts';
import {
  namesCredentialStore,
  SEEKS_CREDENTIALS_REASON,
  seeksCredentials,
} from './credential-stores.ts';

describe('a command that looks for saved passwords, cards or keys', () => {
  test.each([
    'find / -name "Login Data" -o -name "Web Data" 2>/dev/null',
    "find / -name 'Login Data For Account'",
    'sqlite3 "$HOME/.config/melete-browser/Default/Web Data" "select * from credit_cards"',
    'ls ~/.config/google-chrome/Default',
    'cp ~/.config/chromium/Default/Cookies /tmp/c',
    'cat ~/.mozilla/firefox/abc.default/logins.json',
    'python3 decrypt.py key4.db',
    'cat ~/.ssh/id_ed25519',
    'cat ~/.git-credentials',
    'cat ~/.aws/credentials',
    'cat ~/.docker/config.json',
    'cat "$HOME/.netrc"',
    'ls ~/.local/share/keyrings',
    'cat ~/.config/gh/hosts.yml',
  ])('names a store: %s', (command) => {
    expect(namesCredentialStore(command)).toBe(true);
  });

  test.each([
    'npm install',
    'pip install requests',
    'curl -sSL https://example.com/data.json -o data.json',
    'grep -rn "login" src',
    'echo "web data and local state management"',
    'python analyse.py cookies.csv',
    'git clone https://github.com/example/repo.git',
    'ssh-keygen --help',
  ])('does not name one: %s', (command) => {
    expect(namesCredentialStore(command)).toBe(false);
  });

  test('only commands are judged by their text', () => {
    const payload = { command: 'find / -name "Login Data"' };
    expect(seeksCredentials('terminal.run', payload)).toBe(true);
    expect(seeksCredentials('process.start', payload)).toBe(true);
    expect(seeksCredentials('files.write', payload)).toBe(false);
  });

  test('reading a credential store asks the person, with the reason', () => {
    const decision = reviewTier({
      tool: { name: 'terminal.run', effect_class: 'write_reversible', requires_approval: false },
      provider: 'sandbox',
      payload: { command: 'find / -name "Login Data" -o -name "Web Data"' },
      doubts: [],
    });
    expect(decision).toEqual({
      tier: 'person',
      actionClass: null,
      reason: SEEKS_CREDENTIALS_REASON,
    });
    // The same tool on an ordinary command stays the agent's own work.
    expect(
      reviewTier({
        tool: { name: 'terminal.run', effect_class: 'write_reversible', requires_approval: false },
        provider: 'sandbox',
        payload: { command: 'ls -la /work' },
        doubts: [],
      }).tier,
    ).toBe('sandbox');
  });
});
