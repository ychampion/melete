import { expect, test } from 'bun:test';
import { hideCardDetails } from './permissions.ts';

test('a money card shows a card number by its last four, and no digit typed into card details', () => {
  expect(hideCardDetails('Text', '4111111111111111')).toBe('[card ending 1111]');
  expect(hideCardDetails('Text', '4111 1111 1111 1111')).toBe('[card ending 1111]');
  expect(hideCardDetails('Text', 'card 4111111111111111 exp 12/27 cvc 737')).toBe(
    'card [card ending 1111] exp ••/•• cvc •••',
  );
  // A code or expiry on its own, a piece of a number, keys one at a time.
  expect(hideCardDetails('Text', '737')).toBe('•••');
  expect(hideCardDetails('Value', '4111')).toBe('••••');
  expect(hideCardDetails('Keys', '4 then 1 then 1')).toBe('• then • then •');
  // A form field named for a card's code or expiry.
  expect(hideCardDetails('cvc', '123')).toBe('•••');
  expect(hideCardDetails('cc-exp', '12/27')).toBe('••/••');
  // Any other fact keeps its digits, but for a card number.
  expect(hideCardDetails('Where', '10, 270 on the screen')).toBe('10, 270 on the screen');
  expect(hideCardDetails('Command', 'xdotool type 4111111111111111')).toBe(
    'xdotool type [card ending 1111]',
  );
  // Two cards, and a mark of the kind used to set them aside, typed as text.
  expect(hideCardDetails('Text', `${''}4111111111111111 or 378282246310005`)).toBe(
    '�[card ending 1111] or [card ending 0005]',
  );
  // Numbers run together are hidden whole.
  expect(hideCardDetails('Command', 'echo 4111111111111111 378282246310005')).not.toMatch(
    /4111|3782/,
  );
});
