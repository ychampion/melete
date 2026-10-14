export type VisibleControl = { label: string; role: string; required: boolean; sensitive: boolean };
export type VisibleSchema = VisibleControl[];
/**
 * Names of the things a person keeps secret, as a field's label or a line of
 * page text says them: sign-in secrets and one-time or backup codes; identity
 * numbers (a social security, national or tax id); a security question's
 * answer; a card known only by its label (its number, expiry or code); and a
 * bank account's or routing number.
 */
export const sensitiveName = new RegExp(
  `(?:^|[^a-z0-9])(?:${[
    // Signing in, and the codes that go with it.
    'password|passcode|otp|totp|mfa|2fa|pin|secret|one[ _-]?time|authenticate|authenticator',
    '(?:security|verification|authentication|auth|recovery|backup)[ _-]?codes?',
    'api[ _-]?key|access[ _-]?token|sign[ _-]?in|log[ _-]?in',
    // Identity numbers.
    'ssn|social[ _-]?security|national[ _-]?(?:id|identity|insurance)(?:[ _-]?(?:number|no))?',
    'tax[ _-]?(?:id|identification)|taxpayer[ _-]?(?:id|identification)|itin',
    // A security question's answer.
    '(?:security|secret)[ _-]?(?:question|answer)s?|maiden[ _-]?name',
    // A card, by its label alone.
    'cvv2?|cvc2?|csc|card[ _-]?(?:number|no|num|expiry|expiration)|credit[ _-]?card|debit[ _-]?card',
    // A card field by its autocomplete name, used as a field's name or id: cc-exp, cc_exp_month.
    'cc[ _-]?(?:number|num|exp(?:iry|iration)?)(?:[ _-]?(?:month|year|date))?',
    'expiry[ _-]?date|expiration[ _-]?date|exp[ _-]?date|mm[ _/-]*yy',
    // A bank account.
    'account[ _-]?(?:number|no)|bank[ _-]?account|routing[ _-]?(?:number|no)|aba|iban|sort[ _-]?code',
  ].join('|')})(?:$|[^a-z0-9])`,
  'i',
);

/**
 * A field label that is nothing but a code or an expiry ("Code", "Enter the 6-digit code",
 * "Expires"). On its own such a label asks for a one-time code or a card's expiry. It counts
 * only as a field's whole label, never in page text, where "Promo code" or "Offer expires"
 * is ordinary.
 */
export const secretFieldLabel =
  /^\W*(?:(?:enter|type|input)\s+)?(?:(?:the|your)\s+)?(?:\d+[\s-]*digits?\s+)?(?:code|pin|cvv|cvc|expires|expiry|exp)(?:\s+here)?\W*$/i;

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
  return (
    sensitiveName.test(control.label) ||
    secretFieldLabel.test(control.label) ||
    sensitiveName.test(control.role)
  );
}

/**
 * A field's name or id read as words, so `verificationCode`, `otp_code` and `cc-exp` are
 * checked the way a label is.
 */
export function attributeWords(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
}
