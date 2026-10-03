/**
 * Whether an answer from a service holds a credential, so the relay can keep
 * it from the agent's computer. Any adapter may use it from its
 * `answerCheck`: the account's own secret is redacted anyway, but a service
 * can hand back other credentials (a session, an access or refresh token, a
 * password, a private key), and none of them may reach the computer.
 *
 * It looks for credential-shaped fields with a value (as JSON keys, XML
 * elements or form fields, in any case and with `_` or `-` or neither) and
 * for private keys in PEM. Field names that only page through results or
 * mark a retry (`NextToken`, `ClientToken`) are not credentials.
 */

/** Normalised field names (lower case, no `_` or `-`) and what each holds. */
const FIELDS: Record<string, string> = {
  secretaccesskey: 'an AWS secret access key',
  sessiontoken: 'a session token',
  // Systems Manager's StartSession answers with the session's own token beside its StreamUrl.
  tokenvalue: 'a session token',
  securitytoken: 'a session token',
  accesstoken: 'an access token',
  refreshtoken: 'a refresh token',
  idtoken: 'an identity token',
  authorizationtoken: 'an authorization token',
  authtoken: 'an authorization token',
  bearertoken: 'a bearer token',
  apitoken: 'an API token',
  oauthtoken: 'an OAuth token',
  privatetoken: 'a private token',
  clientsecret: 'a client secret',
  secret: 'a secret',
  privatekey: 'a private key',
};
/** Any field whose normalised name ends in `password` (`DbPassword`, `masterUserPassword`). */
const PASSWORD = /password$/;

const normalise = (name: string) => name.toLowerCase().replace(/[_-]/g, '');

function fieldReason(name: string): string | null {
  const key = normalise(name);
  if (FIELDS[key]) return FIELDS[key];
  if (PASSWORD.test(key)) return 'a password';
  return null;
}

/** Field names with a non-empty value: JSON string keys, XML elements, form fields. */
const SHAPES: RegExp[] = [
  /"([A-Za-z0-9_-]{1,64})"\s*:\s*"(?!")/g,
  /<([A-Za-z0-9_-]{1,64})>[^<\s]/g,
  /(?:^|&)([A-Za-z0-9_-]{1,64})=[^&\s]/g,
];
/** What holds a credential whatever the encoding (CBOR names its fields in plain bytes). */
const RAW: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, 'a private key'],
  [/secret_?access_?key/i, 'an AWS secret access key'],
  [/session_?token/i, 'a session token'],
];

/** What credential `text` holds, in words for the computer, or null. */
export function credentialInText(text: string): string | null {
  for (const [pattern, what] of RAW) if (pattern.test(text)) return what;
  for (const shape of SHAPES)
    for (const match of text.matchAll(shape)) {
      const reason = match[1] ? fieldReason(match[1]) : null;
      if (reason) return reason;
    }
  return null;
}

/** What credential an answer's body or headers hold, or null. */
export function credentialInAnswer(answer: {
  body: Buffer;
  headers: Record<string, string>;
}): string | null {
  const inBody = credentialInText(answer.body.toString('latin1'));
  if (inBody) return inBody;
  for (const [name, value] of Object.entries(answer.headers)) {
    if (!value) continue;
    const reason = fieldReason(name.replace(/^x-/i, '')) ?? credentialInText(value);
    if (reason) return reason;
  }
  return null;
}
