/**
 * The names an installation goes by: what the app calls itself
 * (`MELETE_INSTANCE_NAME`) and what the assistant calls itself
 * (`MELETE_ASSISTANT_NAME`). Both default to "Melete", and the assistant takes
 * the installation's name when only that is set.
 *
 * This file imports nothing, because the web client's file server reads it in
 * an image that carries no packages.
 */

export const DEFAULT_INSTANCE_NAME = 'Melete';

/** Long enough for "Riverside Primary School Assistant", short enough for a tab title. */
export const DISPLAY_NAME_MAX = 60;

/**
 * What a name may not hold: control characters (a newline among them), the
 * Unicode line and paragraph separators, which break a line where a newline
 * is refused, and the marks that reorder text, which make a name read as
 * something other than it is in a tab or a mail subject.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
const REFUSED = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;

/**
 * A setting's name, trimmed, or the default when it is unset or blank. A name
 * with a character REFUSED names, or over the limit, is refused with a
 * message that names the setting, because it is placed in page titles, mail
 * subjects and the assistant's identity.
 */
export function displayName(value: string | undefined, setting: string): string {
  const name = value?.trim() ?? '';
  if (!name) return DEFAULT_INSTANCE_NAME;
  if (REFUSED.test(name) || name.length > DISPLAY_NAME_MAX)
    throw new Error(
      `${setting} must be one line of at most ${DISPLAY_NAME_MAX} characters, for example "Riverside Assistant".`,
    );
  return name;
}

/**
 * What the assistant is called: `MELETE_ASSISTANT_NAME`, or the installation's
 * name when only `MELETE_INSTANCE_NAME` is set, so an installation named once
 * reads as one name throughout. Melete when neither is set.
 */
export function assistantDisplayName(
  assistant: string | undefined,
  instance: string | undefined,
): string {
  return assistant?.trim()
    ? displayName(assistant, 'MELETE_ASSISTANT_NAME')
    : displayName(instance, 'MELETE_INSTANCE_NAME');
}
