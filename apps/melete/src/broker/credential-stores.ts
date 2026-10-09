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
 * Only a path written out in full counts: a home prefix, the profile folder,
 * and one of these names exactly as Chromium spells it, with no `.` or `..`
 * steps, globs, variables or anything after the name. So `..`, a differently
 * cased name, or another file reached through a folder of the same name never
 * matches.
 */
const PROFILE_DIAGNOSTIC =
  /^(?:~|\$HOME|\$\{HOME\}|\/root|\/home\/[A-Za-z0-9_][A-Za-z0-9._-]*)\/+\.config\/+melete-browser\/+(?:DevToolsActivePort|SingletonLock|SingletonSocket|SingletonCookie|chrome_debug\.log)$/;

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
  '[',
]);

/** Flags that make `grep` or `ls` walk a folder rather than read one file. */
const RECURSES: Record<string, RegExp> = {
  grep: /^-(?:[^-]*[rRd]|-(?:recursive|dereference-recursive|directories|devices))/,
  ls: /^-(?:[^-]*R|-recursive)/,
};

/** A word of a shell command, after quotes are removed, with where it sits in the text. */
interface Word {
  text: string;
  start: number;
  end: number;
}

/** One simple command: its words, and the files its redirections name. */
interface Simple {
  words: Word[];
  targets: Word[];
}

/** Stands in for a command substitution inside a word; its commands are read on their own. */
const SUBSTITUTION = '\u0000';

/**
 * Splits a command into simple commands the way a POSIX shell reads it, as far
 * as this check needs: quotes, escapes, `$(...)`, separators and redirections.
 * Returns null for anything it does not follow (backquotes, here-documents,
 * process and arithmetic substitution, unbalanced quotes); the whole text is
 * then judged as before.
 */
function simpleCommands(source: string): Simple[] | null {
  const out: Simple[] = [];
  return scan(source, 0, 0, out) === source.length ? out : null;
}

/** How deep `$(...)` may nest before the command is judged as plain text. */
const MAX_NESTING = 16;

/** Reads from `from` to the end, or to the `)` closing a `$(` when nested; -1 when it cannot. */
function scan(src: string, from: number, level: number, out: Simple[]): number {
  if (level > MAX_NESTING) return -1;
  const nested = level > 0;
  let simple: Simple = { words: [], targets: [] };
  let word: Word | null = null;
  let quoted = false;
  let redirect = false;
  let depth = 0;
  const begin = (at: number): Word => {
    word ??= { text: '', start: at, end: at };
    return word;
  };
  const endWord = (at: number) => {
    if (word === null) return;
    word.end = at;
    (redirect ? simple.targets : simple.words).push(word);
    redirect = false;
    word = null;
    quoted = false;
  };
  const endSimple = (): boolean => {
    if (redirect) return false;
    if (simple.words.length > 0 || simple.targets.length > 0) out.push(simple);
    simple = { words: [], targets: [] };
    return true;
  };
  let i = from;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t') {
      endWord(i);
      i += 1;
    } else if (c === '<' || c === '>' || (c === '&' && src[i + 1] === '>')) {
      // Digits written right before the operator are a descriptor, not a file.
      const current = word as Word | null;
      if (current !== null && !quoted && /^\d+$/.test(current.text)) {
        word = null;
        quoted = false;
      } else endWord(i);
      if (redirect) return -1;
      const next = src[i + 1];
      if (c === '<' && (next === '<' || next === '(')) return -1;
      if (c === '>' && next === '(') return -1;
      i += c === '&' ? 2 : 1;
      const op = src[i];
      if (op === '>' || op === '&' || op === '|' || (c === '<' && op === '>')) i += 1;
      redirect = true;
    } else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      endWord(i);
      if (!endSimple()) return -1;
      i += 1;
      if (c === '(') depth += 1;
      if (c === ')') {
        if (depth > 0) depth -= 1;
        else return nested ? i : -1;
      }
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1);
      if (close < 0) return -1;
      begin(i).text += src.slice(i + 1, close);
      quoted = true;
      i = close + 1;
    } else if (c === '"') {
      const w = begin(i);
      quoted = true;
      i += 1;
      for (;;) {
        const d = src[i];
        if (d === undefined || d === '`') return -1;
        if (d === '"') break;
        if (d === '\\') {
          const e = src[i + 1];
          if (e === undefined) return -1;
          if (e === '\n') i += 2;
          else if ('$`"\\'.includes(e)) {
            w.text += e;
            i += 2;
          } else {
            w.text += d;
            i += 1;
          }
        } else if (d === '$' && src[i + 1] === '(') {
          if (src[i + 2] === '(') return -1;
          i = scan(src, i + 2, level + 1, out);
          if (i < 0) return -1;
          w.text += SUBSTITUTION;
        } else {
          w.text += d;
          i += 1;
        }
      }
      i += 1;
    } else if (c === '\\') {
      const e = src[i + 1];
      if (e === undefined) return -1;
      if (e !== '\n') {
        begin(i).text += e;
        quoted = true;
      }
      i += 2;
    } else if (c === '`') {
      return -1;
    } else if (c === '$' && src[i + 1] === '(') {
      if (src[i + 2] === '(') return -1;
      const w = begin(i);
      i = scan(src, i + 2, level + 1, out);
      if (i < 0) return -1;
      w.text += SUBSTITUTION;
    } else {
      begin(i).text += c;
      i += 1;
    }
  }
  endWord(i);
  if (nested || depth > 0 || !endSimple()) return -1;
  return i;
}

/**
 * The command with each plain read of a profile diagnostic file blanked out,
 * or the command unchanged when any other word in it, or any file one of its
 * redirections names, names a store. What remains is judged as before.
 */
function withoutProfileDiagnostics(command: string): string {
  if (!command.includes('melete-browser')) return command;
  const commands = simpleCommands(command);
  if (commands === null) return command;
  const reads: Word[] = [];
  for (const { words, targets } of commands) {
    const program = words[0]?.text ?? '';
    const recurses = RECURSES[program];
    const reader =
      READERS.has(program) && (recurses === undefined || !words.some((w) => recurses.test(w.text)));
    for (const [index, w] of words.entries()) {
      if (reader && index > 0 && PROFILE_DIAGNOSTIC.test(w.text)) reads.push(w);
      else if (namesStore(w.text)) return command;
    }
    // A redirection writes to the file it names (or feeds it in): never one of these reads.
    if (targets.some((w) => namesStore(w.text))) return command;
  }
  let text = command;
  for (const w of reads) {
    text = text.slice(0, w.start) + ' '.repeat(w.end - w.start) + text.slice(w.end);
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
