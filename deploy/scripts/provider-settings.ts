/**
 * What a generated deploy/.env still needs before its selected provider can
 * answer. configure.ts prints these, so an empty key is met while the file is
 * being edited rather than as a refused model call inside the first job.
 */
import {
  CHATGPT_PROVIDER,
  OPENAI_COMPATIBLE,
  PROVIDER_KEY_VARIABLES,
  PROVIDER_NAMES,
  providerKeyVariables,
} from '../../apps/melete/src/gateway/providers.ts';

/**
 * One-line NAME=value settings in deploy/.env, read the way Compose reads the
 * forms configure.ts writes and hand edits commonly use:
 * - an unquoted value ends at the first ` #`, a space and a hash, which starts
 *   a comment; any other `#`, as in a password, is part of the value;
 * - a quoted value ends at its closing quote, and the rest of the line is
 *   ignored; inside double quotes `\"` and `\\` are unescaped;
 * - `$$` is one `$` in an unquoted or double-quoted value, and kept as written
 *   inside single quotes.
 * Compose also expands `$NAME` references and further escapes, and reads values
 * that span lines; those are kept as written here.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  const dollars = (value: string) => value.replace(/\$\$/g, () => '$');
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match?.[1]) continue;
    const raw = match[2] ?? '';
    const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(raw) ?? /^'([^']*)'/.exec(raw);
    values[match[1]] = quoted
      ? raw.startsWith('"')
        ? dollars((quoted[1] ?? '').replace(/\\(["\\])/g, '$1'))
        : (quoted[1] ?? '')
      : dollars((raw.split(' #')[0] ?? '').trimEnd());
  }
  return values;
}

export function providerWarnings(settings: Record<string, string | undefined>): string[] {
  const provider = settings.MELETE_DEFAULT_PROVIDER ?? '';
  if (provider === 'fake')
    return settings.MELETE_ENABLE_FAKE_PROVIDER === 'true'
      ? []
      : [
          'MELETE_DEFAULT_PROVIDER=fake needs MELETE_ENABLE_FAKE_PROVIDER=true in deploy/.env; the service will not start without it.',
        ];
  if (!Object.hasOwn(PROVIDER_KEY_VARIABLES, provider))
    return [
      `MELETE_DEFAULT_PROVIDER=${provider} is not a provider the gateway has, and the service will not start. Use one of: ${PROVIDER_NAMES.join(', ')}. An OpenAI-compatible endpoint is selected by the exact name ${OPENAI_COMPATIBLE}.`,
    ];
  const warnings: string[] = [];
  if (provider === OPENAI_COMPATIBLE && !settings.OPENAI_COMPAT_BASE_URL)
    warnings.push(
      `MELETE_DEFAULT_PROVIDER=${OPENAI_COMPATIBLE} needs OPENAI_COMPAT_BASE_URL in deploy/.env, for example https://models.example.net/v1; the service will not start without it.`,
    );
  // A signed-in provider has no key to set; its tokens are sealed with the master key.
  const signedIn =
    provider === CHATGPT_PROVIDER ||
    (provider === OPENAI_COMPATIBLE &&
      Object.keys(settings).some(
        (name) => name.startsWith('OPENAI_COMPAT_OAUTH_') && settings[name],
      ));
  if (signedIn) {
    if (!settings.MELETE_MASTER_KEY)
      warnings.push(
        `MELETE_DEFAULT_PROVIDER=${provider} is used through the owner's sign-in, which needs MELETE_MASTER_KEY in deploy/.env to seal what the provider issues.`,
      );
    return warnings;
  }
  const variables = providerKeyVariables(provider, settings.OPENAI_COMPAT_BASE_URL);
  if (!variables.some((name) => settings[name]))
    warnings.push(
      `MELETE_DEFAULT_PROVIDER=${provider}, but ${variables.join(' and ')} ${variables.length > 1 ? 'are' : 'is'} empty in deploy/.env. Set the key before starting the stack: until then every model call is refused and no job can answer.${provider === OPENAI_COMPATIBLE && variables.length === 1 ? ' OPENAI_API_KEY is never sent to a plain http:// endpoint.' : ''}`,
    );
  return warnings;
}
