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

describe("the browser's own diagnostic files", () => {
  const profile = '/home/agent/.config/melete-browser';
  const review = (command: string) =>
    reviewTier({
      tool: { name: 'terminal.run', effect_class: 'write_reversible', requires_approval: false },
      provider: 'sandbox',
      payload: { command },
      doubts: [],
    }).tier;

  test.each([
    'cat ~/.config/melete-browser/DevToolsActivePort',
    'cat "$HOME/.config/melete-browser/DevToolsActivePort"',
    `head -1 ${profile}/DevToolsActivePort`,
    'curl -s "http://127.0.0.1:$(head -1 ~/.config/melete-browser/DevToolsActivePort)/json/version"',
    'ls -la ~/.config/melete-browser/SingletonLock',
    `readlink ${profile}/SingletonSocket`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${HOME}
    'stat ${HOME}/.config/melete-browser/SingletonCookie',
    'tail -n 50 ~/.config/melete-browser/chrome_debug.log 2>&1 | grep -i error',
    `ls -l ${profile}/SingletonLock ${profile}/SingletonSocket ${profile}/SingletonCookie; cat ${profile}/DevToolsActivePort > /tmp/port`,
  ])('reading one does not ask: %s', (command) => {
    expect(namesCredentialStore(command)).toBe(false);
    expect(seeksCredentials('terminal.run', { command })).toBe(false);
    expect(seeksCredentials('process.start', { command })).toBe(false);
    expect(review(command)).toBe('sandbox');
  });

  test.each([
    // Everything else in the profile folder.
    `cat "${profile}/Default/Login Data"`,
    `cp ${profile}/Default/Cookies /tmp/c`,
    `cat ${profile}/Local\\ State`,
    `ls ${profile}`,
    `ls ${profile}/`,
    `cat ${profile}/Default/Preferences`,
    `ls ${profile}/Default/Local\\ Storage`,
    `cat ${profile}/Singleton*`,
    `cat ${profile}/DevToolsActivePort*`,
    `cat ${profile}/{DevToolsActivePort,Default/Cookies}`,
    `cat ${profile}/$NAME`,
    // Steps out of the folder, other spellings, and folders named like an allowed file.
    `cat ${profile}/DevToolsActivePort/../Default/Cookies`,
    `cat ${profile}/./DevToolsActivePort`,
    `cat ${profile}/../melete-browser/DevToolsActivePort`,
    `cat /home/../root/.config/melete-browser/DevToolsActivePort`,
    `cat ${profile}/devtoolsactiveport`,
    `cat /home/agent/.config/Melete-Browser/DevToolsActivePort`,
    `cat ${profile}/chrome_debug.log/Login\\ Data`,
    `grep -r . ${profile}/DevToolsActivePort`,
    `grep -R . ${profile}/SingletonLock`,
    `ls -R ${profile}/SingletonLock`,
    // A symbolic link is made by writing in the folder, which asks.
    `ln -s "${profile}/Default/Login Data" ${profile}/DevToolsActivePort && cat ${profile}/DevToolsActivePort`,
    `ln -sf Default/Login* ${profile}/DevToolsActivePort; cat ${profile}/DevToolsActivePort`,
    `cd ${profile} && ln -s Default/Cook* chrome_debug.log`,
    // Writes to an allowed file.
    `echo 9222 > ${profile}/DevToolsActivePort`,
    `cat /tmp/x >> ${profile}/chrome_debug.log`,
    `: >${profile}/chrome_debug.log`,
    `cat /tmp/x 1>${profile}/DevToolsActivePort`,
    `echo x | tee ${profile}/DevToolsActivePort`,
    `rm -f ${profile}/SingletonLock ${profile}/SingletonSocket ${profile}/SingletonCookie`,
    `touch ${profile}/SingletonLock`,
    `cp /tmp/port ${profile}/DevToolsActivePort`,
    `sed -i s/1/2/ ${profile}/DevToolsActivePort`,
    `truncate -s 0 ${profile}/chrome_debug.log`,
    // A command that touches an allowed file and a guarded one.
    `cat ${profile}/DevToolsActivePort && cat "${profile}/Default/Login Data"`,
    `cat ${profile}/DevToolsActivePort ${profile}/Default/Cookies`,
    `cat ${profile}/DevToolsActivePort; sqlite3 "$HOME/.config/melete-browser/Default/Web Data" .dump`,
    `cat ${profile}/DevToolsActivePort; cat ~/.ssh/id_ed25519`,
    `head -1 ${profile}/DevToolsActivePort; P=${profile}; cat "$P/Default/Login Data"`,
    `cat ${profile}/DevToolsActivePort; cat Default/Login\\ Data`,
    `cat $(echo ${profile}/Default/Cookies) ${profile}/DevToolsActivePort`,
    `cat ${profile}/DevToolsActivePort < ${profile}/Default/Cookies`,
    // Syntax the check does not follow keeps today's answer.
    `cat \`echo ${profile}/DevToolsActivePort\``,
    `cat <<EOF\n${profile}/DevToolsActivePort\nEOF`,
    `cat "${profile}/DevToolsActivePort`,
  ])('anything else there still asks: %s', (command) => {
    expect(namesCredentialStore(command)).toBe(true);
    expect(seeksCredentials('terminal.run', { command })).toBe(true);
    expect(review(command)).toBe('person');
  });
});
