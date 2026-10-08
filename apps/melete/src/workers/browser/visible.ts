export type VisibleControl = { label: string; role: string; required: boolean; sensitive: boolean };
export type VisibleSchema = VisibleControl[];
export const sensitiveName =
  /(?:^|[^a-z0-9])(?:password|passcode|otp|totp|mfa|2fa|pin|cvv|cvc|secret|one[ _-]?time|security[ _-]?code|verification[ _-]?code|authentication[ _-]?code|recovery[ _-]?code|backup[ _-]?code|api[ _-]?key|access[ _-]?token|sign[ _-]?in|log[ _-]?in|authenticate)(?:$|[^a-z0-9])/i;

/** Roles a person types or picks a value into. Only these can take a secret. */
const INPUT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

/**
 * Whether a control is where a secret goes: a password, one-time-code or card
 * field by its type or autocomplete hint (`sensitive`), or an input named for
 * one. A link or button that only leads to signing in ("Sign in", "Log in")
 * takes nothing, so its name alone never counts.
 */
export function isSensitiveControl(control: VisibleControl): boolean {
  if (control.sensitive) return true;
  if (!INPUT_ROLES.has(control.role)) return false;
  return sensitiveName.test(control.label) || sensitiveName.test(control.role);
}
