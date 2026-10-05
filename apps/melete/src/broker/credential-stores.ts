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

/** Whether a command's text names a store of saved passwords, cards, cookies or keys. */
export function namesCredentialStore(command: string): boolean {
  return BROWSER_STORES.test(command) || KEY_FILES.test(command);
}

/** Whether this action is a command that looks for or reads such a store. */
export function seeksCredentials(kind: string, payload: JsonObject): boolean {
  if (!COMMAND_TOOLS.has(kind)) return false;
  const command = payload.command;
  return typeof command === 'string' && namesCredentialStore(command);
}

export const SEEKS_CREDENTIALS_REASON =
  'It looks for or reads saved passwords, payment cards, sign-in cookies or keys.';
