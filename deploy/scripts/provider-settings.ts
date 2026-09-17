/**
 * What a generated deploy/.env still needs before its selected provider can
 * answer. configure.ts prints these, so an empty key is met while the file is
 * being edited rather than as a refused model call inside the first job.
 */
import {
  OPENAI_COMPATIBLE,
  PROVIDER_KEY_VARIABLES,
  PROVIDER_NAMES,
  providerKeyVariables,
} from '../../apps/melete/src/gateway/providers.ts';

/** NAME=value lines, as Compose reads them for plain and double-quoted values. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match?.[1]) continue;
    const value = match[2] ?? '';
    values[match[1]] = /^"(.*)"$/.exec(value)?.[1] ?? /^'(.*)'$/.exec(value)?.[1] ?? value;
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
  const variables = providerKeyVariables(provider, settings.OPENAI_COMPAT_BASE_URL);
  if (!variables.some((name) => settings[name]))
    warnings.push(
      `MELETE_DEFAULT_PROVIDER=${provider}, but ${variables.join(' and ')} ${variables.length > 1 ? 'are' : 'is'} empty in deploy/.env. Set the key before starting the stack: until then every model call is refused and no job can answer.${provider === OPENAI_COMPATIBLE && variables.length === 1 ? ' OPENAI_API_KEY is never sent to a plain http:// endpoint.' : ''}`,
    );
  return warnings;
}
