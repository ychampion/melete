/**
 * The names an installation goes by: what the app calls itself
 * (`MELETE_INSTANCE_NAME`) and what the assistant calls itself
 * (`MELETE_ASSISTANT_NAME`). Both default to "Melete".
 *
 * This file imports nothing, because the web client's file server reads it in
 * an image that carries no packages.
 */

export const DEFAULT_INSTANCE_NAME = 'Melete';

/** Long enough for "Riverside Primary School Assistant", short enough for a tab title. */
export const DISPLAY_NAME_MAX = 60;

/**
 * A setting's name, trimmed, or the default when it is unset or blank. A name
 * with a control character (a newline among them) or over the limit is
 * refused with a message that names the setting, because it is placed in page
 * titles, mail subjects and the assistant's identity.
 */
export function displayName(value: string | undefined, setting: string): string {
  const name = value?.trim() ?? '';
  if (!name) return DEFAULT_INSTANCE_NAME;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name) || name.length > DISPLAY_NAME_MAX)
    throw new Error(
      `${setting} must be one line of at most ${DISPLAY_NAME_MAX} characters, for example "Riverside Assistant".`,
    );
  return name;
}
