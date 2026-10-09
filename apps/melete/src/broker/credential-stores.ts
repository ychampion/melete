/**
 * Commands that look for, or read, the places programs keep saved passwords,
 * payment cards, session cookies and keys.
 *
 * The agent's computer holds none of the person's own browser profiles or key
 * files, but a command that goes looking for them is a risk signal whatever it
 * finds: the person is asked first, with the reason, instead of the command
 * going through as ordinary work in the agent's own workspace. The match is on
 * the command's text, so it is a signal, not a wall; the stores themselves are
 * kept empty where Melete controls them (the sandbox browser saves no
 * passwords, cards or addresses).
 */
import type { JsonObject } from '@melete/contracts';

/** The tools whose payload is a shell command run in the agent's computer. */
const COMMAND_TOOLS = new Set(['terminal.run', 'process.start', 'exec.run']);

/** File names browsers give their stores, matched as written (they are capitalised). */
const BROWSER_STORES =
  /(?:^|[\s"'/=*])(?:Login Data(?: For Account)?|Web Data|Local State|Cookies)(?:$|[\s"'*-])/;

/** Stores and key files by path, in any case. */
const KEY_FILES = new RegExp(
  [
    // Firefox and its relatives.
    String.raw`\blogins\.json\b`,
    String.raw`\bkey[34]\.db\b`,
    String.raw`\bsignons\.sqlite\b`,
    String.raw`\bcookies\.sqlite\b`,
    // Browser profile folders.
    String.raw`\.config/(?:google-chrome|chromium|melete-browser|BraveSoftware|microsoft-edge)\b`,
    String.raw`\.mozilla/firefox\b`,
    // Keyrings and password stores.
    String.raw`\.local/share/keyrings\b`,
    String.raw`\bkwallet`,
    String.raw`\.password-store\b`,
    String.raw`\bkeychain\b`,
    // Keys and tokens command-line tools keep.
    String.raw`\.ssh/id_[a-z0-9]+`,
    String.raw`\.git-credentials\b`,
    String.raw`\.netrc\b`,
    String.raw`\.pgpass\b`,
    String.raw`\.aws/credentials\b`,
    String.raw`\.docker/config\.json\b`,
    String.raw`\.npmrc\b`,
    String.raw`\.pypirc\b`,
    String.raw`\.config/gh/hosts\.yml\b`,
    String.raw`\.kube/config\b`,
    String.raw`\.config/gcloud\b`,
    String.raw`\.gnupg\b`,
  ].join('|'),
  'i',
);

function namesStore(text: string): boolean {
  return BROWSER_STORES.test(text) || KEY_FILES.test(text);
}

/**
 * The files Chromium keeps in the agent's own browser profile to say where it
 * listens and whether it is running: the DevTools port, the single-instance
 * locks and its debug log. None holds a password, card, cookie or key.
 *
 * Only the full literal path counts: `/home/<user>/.config/melete-browser/`
 * and one of these names exactly as Chromium spells it. A relative path, `~`,
 * a variable, `.` or `..` steps, doubled slashes, a different case or anything
 * after the name never matches.
 */
const PROFILE_DIAGNOSTIC =
  /^\/home\/[A-Za-z0-9_][A-Za-z0-9_.-]*\/\.config\/melete-browser\/(?:DevToolsActivePort|SingletonLock|SingletonSocket|SingletonCookie|chrome_debug\.log)$/;

/**
 * A command the shell runs exactly as written: plain words of these characters,
 * separated by blanks, `;`, `&`, `&&`, `|` or `||`, with plain redirections.
 * No quotes, escapes, globs, braces, `~`, variables, substitutions or comments,
 * so every word is the literal file or argument the program receives.
 */
const LITERAL_COMMAND = /^[A-Za-z0-9_./:=,+@%\- \t\n;&|<>]*$/;

/** One token of a literal command: blanks, a separator, a redirection, or a word. */
const TOKEN = /([ \t]+)|(&&|\|\||[;&|\n])|(\d*(?:>>|>&|<&|<>|>\||&>>|&>|>|<)\d*)|([^ \t\n;&|<>]+)/g;

/**
 * Programs that only read the files they are given and never write them. The
 * flags that make `grep` or `ls` walk into a folder are refused below, so a
 * folder named like one of these files shows nothing beyond its own names.
 */
const READERS = new Set([
  'cat',
  'head',
  'tail',
  'ls',
  'stat',
  'readlink',
  'wc',
  'od',
  'hexdump',
  'strings',
  'grep',
  'test',
]);

/** Flags that make `grep` or `ls` walk a folder rather than read one file. */
const RECURSES: Record<string, RegExp> = {
  grep: /^-(?:[^-]*[rRd]|-(?:recursive|dereference-recursive|directories|devices))/,
  ls: /^-(?:[^-]*R|-recursive)/,
};

interface Word {
  text: string;
  start: number;
}

/**
 * The command with each read of a profile diagnostic file blanked out, so the
 * rest is judged as before. Only a literal command qualifies; anything else is
 * returned unchanged. A file named after a redirection is never blanked, since
 * the redirection may write it.
 */
function withoutProfileDiagnostics(command: string): string {
  if (!command.includes('melete-browser') || !LITERAL_COMMAND.test(command)) return command;
  const reads: Word[] = [];
  let words: Word[] = [];
  let target = false;
  const judge = () => {
    const program = words[0]?.text ?? '';
    const recurses = RECURSES[program];
    const reader =
      READERS.has(program) && (recurses === undefined || !words.some((w) => recurses.test(w.text)));
    if (reader) reads.push(...words.slice(1).filter((w) => PROFILE_DIAGNOSTIC.test(w.text)));
    words = [];
  };
  for (const match of command.matchAll(TOKEN)) {
    const [, , separator, redirection, word] = match;
    if (separator !== undefined) {
      judge();
      target = false;
    } else if (redirection !== undefined) {
      target = true;
    } else if (word !== undefined) {
      if (!target) words.push({ text: word, start: match.index });
      target = false;
    }
  }
  judge();
  let text = command;
  for (const w of reads) {
    text = text.slice(0, w.start) + ' '.repeat(w.text.length) + text.slice(w.start + w.text.length);
  }
  return text;
}

/**
 * Whether a command's text names a store of saved passwords, cards, cookies or
 * keys. Reading the browser's own diagnostic files (its DevTools port, its
 * single-instance locks and its debug log) does not count.
 */
export function namesCredentialStore(command: string): boolean {
  return namesStore(withoutProfileDiagnostics(command));
}

/** Whether this action is a command that looks for or reads such a store. */
export function seeksCredentials(kind: string, payload: JsonObject): boolean {
  if (!COMMAND_TOOLS.has(kind)) return false;
  const command = payload.command;
  return typeof command === 'string' && namesCredentialStore(command);
}

export const SEEKS_CREDENTIALS_REASON =
  'It looks for or reads saved passwords, payment cards, sign-in cookies or keys.';
