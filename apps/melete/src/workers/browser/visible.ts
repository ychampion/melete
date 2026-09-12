export type VisibleControl = { label: string; role: string; required: boolean; sensitive: boolean };
export type VisibleSchema = VisibleControl[];
export const sensitiveName =
  /(?:^|[^a-z0-9])(?:password|passcode|otp|totp|mfa|2fa|pin|cvv|cvc|secret|one[ _-]?time|security[ _-]?code|verification[ _-]?code|authentication[ _-]?code|recovery[ _-]?code|backup[ _-]?code|api[ _-]?key|access[ _-]?token|sign[ _-]?in|log[ _-]?in|authenticate)(?:$|[^a-z0-9])/i;

/** Semantic names supplement browser-reported input types and authentication autocomplete hints. */
export function isSensitiveControl(control: VisibleControl): boolean {
  return control.sensitive || sensitiveName.test(control.label) || sensitiveName.test(control.role);
}
