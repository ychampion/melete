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
  const asks = (command: string) => {
    expect(namesCredentialStore(command)).toBe(true);
    expect(seeksCredentials('terminal.run', { command })).toBe(true);
    expect(review(command)).toBe('person');
  };

  test.each([
    `cat ${profile}/DevToolsActivePort`,
    `head -1 ${profile}/DevToolsActivePort`,
    `ls -la ${profile}/SingletonLock`,
    `readlink ${profile}/SingletonSocket`,
    `stat ${profile}/SingletonCookie`,
    `tail -n 50 ${profile}/chrome_debug.log 2>&1 | grep -i error`,
    `ls -l ${profile}/SingletonLock ${profile}/SingletonSocket ${profile}/SingletonCookie; cat ${profile}/DevToolsActivePort > /tmp/port`,
    `cat ${profile}/DevToolsActivePort && curl -s http://127.0.0.1:9222/json/version`,
  ])('reading one does not ask: %s', (command) => {
    expect(namesCredentialStore(command)).toBe(false);
    expect(seeksCredentials('terminal.run', { command })).toBe(false);
    expect(seeksCredentials('process.start', { command })).toBe(false);
    expect(review(command)).toBe('sandbox');
  });

  test.each([
    `cat "${profile}/Default/Login Data"`,
    `cp ${profile}/Default/Cookies /tmp/c`,
    `cat ${profile}/Local\\ State`,
    `ls ${profile}`,
    `ls ${profile}/`,
    `cat ${profile}/Default/Preferences`,
    `ls ${profile}/Default/Local\\ Storage`,
  ])('the rest of the profile folder still asks: %s', asks);

  // Each of these went through under a looser reading of the command.
  test.each([
    // Quotes and escapes.
    `cat "${profile}/DevToolsActivePort"`,
    `cat '${profile}/DevToolsActivePort'`,
    `cat ${profile}/DevTools\\ActivePort`,
    `cat "${profile}/DevToolsActivePort "`,
    `cat "x ${profile}/DevToolsActivePort y"`,
    // Variables and the home shorthand.
    'cat ~/.config/melete-browser/DevToolsActivePort',
    'cat $HOME/.config/melete-browser/DevToolsActivePort',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${HOME}
    'cat ${HOME}/.config/melete-browser/DevToolsActivePort',
    `cat ${profile}/$NAME`,
    `HOME=/tmp cat ${profile}/DevToolsActivePort`,
    // Substitutions.
    `echo $(cat ${profile}/DevToolsActivePort)`,
    `curl -s http://127.0.0.1:$(head -1 ${profile}/DevToolsActivePort)/json/version`,
    // Doubled slashes and a NUL.
    `cat /home/agent//.config/melete-browser/DevToolsActivePort`,
    `cat ${profile}//DevToolsActivePort`,
    `cat ${profile}/DevToolsActivePort\u0000`,
    `cat ${profile}/DevToolsActivePort\r`,
  ])('a command that is not plain literal words asks: %s', asks);

  test.each([
    // Globs and braces, which could expand to another file.
    `cat ${profile}/Singleton*`,
    `cat ${profile}/*`,
    `cat ${profile}/DevToolsActivePor?`,
    `cat ${profile}/[D]evToolsActivePort`,
    `cat ${profile}/{DevToolsActivePort,Default/Cookies}`,
    // Separators, substitutions and redirections that bring in a guarded file.
    `cat ${profile}/DevToolsActivePort && cat "${profile}/Default/Login Data"`,
    `cat ${profile}/DevToolsActivePort ${profile}/Default/Cookies`,
    `cat ${profile}/DevToolsActivePort | cat - ${profile}/Default/Cookies`,
    `cat ${profile}/DevToolsActivePort; cat ~/.ssh/id_ed25519`,
    `cat $(echo ${profile}/Default/Cookies) ${profile}/DevToolsActivePort`,
    `cat \`echo ${profile}/DevToolsActivePort\``,
    `cat ${profile}/DevToolsActivePort < "${profile}/Default/Login Data"`,
    `cat ${profile}/DevToolsActivePort < ${profile}/Default/Cookies`,
    `cat <<EOF\n${profile}/DevToolsActivePort\nEOF`,
    // Relative paths, `.` and `..` steps, and folders named like an allowed file.
    'cat .config/melete-browser/DevToolsActivePort',
    `cat /home/agent/./.config/melete-browser/DevToolsActivePort`,
    `cat ${profile}/./DevToolsActivePort`,
    `cat ${profile}/../melete-browser/DevToolsActivePort`,
    `cat /home/../home/agent/.config/melete-browser/DevToolsActivePort`,
    `cat ${profile}/DevToolsActivePort/../Default/Cookies`,
    `cat ${profile}/chrome_debug.log/Login\\ Data`,
    `grep -r . ${profile}/DevToolsActivePort`,
    `grep -R . ${profile}/SingletonLock`,
    `ls -R ${profile}/SingletonLock`,
    // Case.
    `cat ${profile}/devtoolsactiveport`,
    `cat /home/agent/.config/Melete-Browser/DevToolsActivePort`,
    `cat /home/agent/.Config/melete-browser/DevToolsActivePort`,
    // A symbolic link is made by writing in the folder, which asks.
    `ln -s "${profile}/Default/Login Data" ${profile}/DevToolsActivePort && cat ${profile}/DevToolsActivePort`,
    `ln -sf Default/Login ${profile}/DevToolsActivePort; cat ${profile}/DevToolsActivePort`,
    `cd ${profile} && ln -s Default/Cookies chrome_debug.log`,
    // Writes to an allowed file.
    `echo 9222 > ${profile}/DevToolsActivePort`,
    `cat /tmp/x >> ${profile}/chrome_debug.log`,
    `cat /tmp/x 1>${profile}/DevToolsActivePort`,
    `echo x | tee ${profile}/DevToolsActivePort`,
    `rm -f ${profile}/SingletonLock ${profile}/SingletonSocket ${profile}/SingletonCookie`,
    `touch ${profile}/SingletonLock`,
    `cp /tmp/port ${profile}/DevToolsActivePort`,
    `sed -i s/1/2/ ${profile}/DevToolsActivePort`,
    `truncate -s 0 ${profile}/chrome_debug.log`,
    `cat ${profile}/DevToolsActivePort > Default/Login\\ Data`,
  ])('anything else there still asks: %s', asks);
});
