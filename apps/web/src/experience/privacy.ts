/** Plain names for what the privacy router swaps out, shared by Settings and the chat. */
import type { PrivacyCategory } from './types.ts';

/** In the order the settings list them. */
export const CATEGORY_NAMES: Record<PrivacyCategory, string> = {
  account: 'Bank and account numbers',
  card: 'Card numbers',
  routing: 'Routing and sort codes',
  ssn: 'Social Security numbers',
  tax_id: 'Tax IDs',
  national_id: 'National ID numbers',
  passport: 'Passport numbers',
  license: 'Driving licence numbers',
  health: 'Health details',
  address: 'Street addresses',
  phone: 'Phone numbers',
  email: 'Email addresses',
  dob: 'Dates of birth',
  credential: 'Passwords and keys',
  name: 'Names you list below',
  private: 'Other things you list below',
};

/** What a single detail is, in a list or a picker. */
export const kindOf = (category: PrivacyCategory) =>
  category === 'name' ? 'Name' : category === 'private' ? 'Other' : CATEGORY_NAMES[category];
