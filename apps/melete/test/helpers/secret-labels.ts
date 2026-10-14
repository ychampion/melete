/** Field labels the browser tools treat as a secret's, and ordinary ones beside them. */
/** Labels a field for a secret is known by, beyond passwords and codes, one per kind. */
export const SECRET_LABELS = [
  'SSN',
  'Social Security number',
  'National ID number',
  'National insurance number',
  'Tax ID',
  'Taxpayer identification number',
  'ITIN',
  'Security question',
  'Answer to your security question',
  'Secret answer',
  "Mother's maiden name",
  'Card number',
  'Credit card',
  'Debit card number',
  'Expiry date',
  'Expiration date',
  'MM/YY',
  'CVV',
  'CVV2',
  'CSC',
  'Account number',
  'Bank account',
  'Routing number',
  'ABA',
  'IBAN',
  'Sort code',
  'Backup codes',
  'Recovery codes',
  'Authenticator code',
] as const;

/**
 * Labels that are only a code or an expiry. As a field's whole label they ask for a secret;
 * in page text ("Offer expires", "Promo code") they are ordinary words.
 */
export const BARE_CODE_LABELS = [
  'Code',
  'Enter code',
  'Enter the code',
  'Your code',
  'Enter the 6-digit code',
  '6 digit code',
  'Code:',
  'Expires',
  'Expiry',
  'Exp.',
  'PIN',
  'CVV',
  'Verification code',
] as const;

/** Field names and ids a code or card field is known by. */
export const SECRET_FIELD_NAMES = [
  'otp',
  'otpCode',
  'verification_code',
  'verificationCode',
  'code',
  'pin',
  'cc-exp',
  'cc-exp-month',
  'cc_exp_year',
  'ccNumber',
  'cc-csc',
] as const;

/** Ordinary field names and ids, some sharing a word with a secret's. */
export const ORDINARY_FIELD_NAMES = [
  'promo_code',
  'zipCode',
  'postal-code',
  'pincode',
  'shipping',
  'expires_at_note',
  'guests',
  'country_code',
] as const;

/** An ordinary form's labels, some sharing a word with a secret's. */
export const ORDINARY_LABELS = [
  'Name',
  'Email',
  'Phone',
  'Street address',
  'City',
  'ZIP code',
  'Promo code',
  'Order number',
  'Tracking number',
  'Company',
  'Account name',
  'Card holder',
  'Date of birth',
  'Message',
] as const;
