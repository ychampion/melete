import { describe, expect, test } from 'bun:test';
import type { JsonObject } from '@melete/contracts';
import {
  browserPays,
  type ComputerStep,
  cardDigits,
  holdsCardNumber,
  payMoment,
  screenOf,
} from './pay-moment.ts';

const VISA = '4111111111111111';
const AMEX = '378282246310005';

/** A screen as a receipt keeps it: accessibility lines on a page. */
const screen = (url: string, lines: string[], source = 'accessibility') =>
  screenOf({ url, source, lines: lines.join('\n') });

const checkout = (focused: 'number' | 'code' | 'email' | null = null) =>
  screen('https://shop.example.com/checkout', [
    'n1 heading "Checkout" box=0,0,800,40',
    'n2 text "Order total $24.99" box=0,50,300,20',
    `n3 textbox "Email"${focused === 'email' ? ' [focused]' : ''} box=0,100,300,30`,
    `n4 textbox "Card number"${focused === 'number' ? ' [focused]' : ''} box=0,150,300,30`,
    'n5 textbox "Expiry (MM/YY)" box=0,200,140,30',
    `n6 textbox "Security code"${focused === 'code' ? ' [focused]' : ''} box=160,200,140,30`,
    'n7 button "Pay $24.99" box=0,260,300,40',
    'n8 button "Back" box=320,260,100,40',
  ]);

/** A form whose fields say nothing about cards, the way a frame from elsewhere shows it. */
const bare = (focusedRef: string | null = null) =>
  screen('https://pay.example.org/form', [
    'n1 text "Amount due 120.00 USD" box=0,0,300,20',
    ...['n2', 'n3', 'n4', 'n5'].map(
      (ref, i) => `${ref} textbox${ref === focusedRef ? ' [focused]' : ''} box=${i * 80},100,70,30`,
    ),
    'n6 generic "Continue" box=0,200,200,40',
  ]);

const step = (kind: string, payload: JsonObject, after: ComputerStep['after'] = null) => ({
  kind,
  payload,
  after,
});
const click = (x: number, y: number, after: ComputerStep['after'] = null) =>
  step('computer.click', { x, y }, after);
const type = (text: string, after: ComputerStep['after'] = null) =>
  step('computer.type', { text }, after);
const keys = (list: string[], after: ComputerStep['after'] = null) =>
  step('computer.key', { keys: list }, after);

describe('card numbers', () => {
  test('Luhn and a network first digit', () => {
    expect(cardDigits(VISA)).toBe(true);
    expect(cardDigits(AMEX)).toBe(true);
    expect(cardDigits('4111111111111112')).toBe(false);
    // Luhn-valid but no card network starts with 0, 1, 7, 8 or 9.
    expect(cardDigits('0000000000000000')).toBe(false);
    expect(cardDigits('7992739871300')).toBe(false);
  });

  test('written whole, grouped or in full-width digits', () => {
    expect(holdsCardNumber(`my card is ${VISA} thanks`)).toBe(true);
    expect(holdsCardNumber('4111 1111 1111 1111')).toBe(true);
    expect(holdsCardNumber('4111-1111-1111-1111')).toBe(true);
    expect(holdsCardNumber('3782 822463 10005')).toBe(true);
    expect(holdsCardNumber('４１１１１１１１１１１１１１１１')).toBe(true);
    // The number then its code: the groups that make the card still do.
    expect(holdsCardNumber('4111 1111 1111 1111 123')).toBe(true);
    // A field cut at its length keeps the start.
    expect(holdsCardNumber(`${VISA}0000`)).toBe(true);
  });

  test('numbers that are not cards are not flagged', () => {
    for (const text of [
      '+1 (415) 555-0134',
      '4155550134',
      'Order 4111111111111112',
      'tracking 9400 1000 0000 0000 0000 00',
      'IBAN GB82 WEST 1234 5698 7654 32',
      '2026-10-18',
      'account 1234567890123',
      // A long reference number is never read from its middle.
      `ref 9${VISA}9`,
    ])
      expect(holdsCardNumber(text)).toBe(false);
  });
});

describe('the agent’s own computer', () => {
  test('a card number typed anywhere is held, at once or in a batch', () => {
    expect(payMoment([], type(VISA))?.reason).toBe('It types a card number.');
    expect(
      payMoment([], step('computer.batch', { actions: [{ action: 'type', text: VISA }] })),
    ).not.toBeNull();
  });

  test('a number that is not a card goes on', () => {
    expect(payMoment([click(10, 110, checkout())], type('+1 415 555 0134'))).toBeNull();
    expect(payMoment([click(10, 110, checkout())], type('4111111111111112'))).toBeNull();
    expect(payMoment([], type('Meeting at 4pm, room 2205'))).toBeNull();
  });

  test('typing into a field named as a card’s is held, with the site and amount', () => {
    const moment = payMoment([click(10, 160, checkout())], click(10, 160));
    expect(moment).toBeNull();
    const typed = payMoment([click(10, 160, checkout('number'))], type('4'));
    expect(typed?.reason).toBe('It types into a card’s field.');
    expect(typed?.site).toBe('shop.example.com');
    expect(typed?.amount).toBe('$24.99');
    expect(payMoment([click(170, 210, checkout('code'))], type('123'))).not.toBeNull();
  });

  test('a field is followed by focus as the screen reports it', () => {
    // Clicking the email field, then typing digits there, is not a card field.
    expect(payMoment([click(10, 110, checkout('email'))], type('4155'))).toBeNull();
    // Tab moves on to the card number: the next screen says so.
    expect(payMoment([keys(['Tab'], checkout('number'))], type('41'))).not.toBeNull();
  });

  test('digits typed in pieces into one field are read whole', () => {
    const before = [
      click(10, 110, bare('n2')),
      type('4111', bare('n2')),
      type('1111', bare('n2')),
      type('1111', bare('n2')),
    ];
    expect(payMoment(before, type('1111'))?.reason).toBe('It types a card number.');
    // A digit at a time, by key, across steps and in a batch.
    const byKey = VISA.split('');
    const steps = [click(10, 110, bare('n2')), keys(byKey.slice(0, 8), bare('n2'))];
    expect(
      payMoment(
        steps,
        step('computer.batch', {
          actions: [
            { action: 'key', keys: byKey.slice(8, 12) },
            { action: 'key', keys: byKey.slice(12) },
          ],
        }),
      ),
    ).not.toBeNull();
    // Two-digit pieces, each its own step.
    const pairs = VISA.match(/../g) as string[];
    const typedPairs = pairs.slice(0, -1).map((pair) => type(pair, bare('n2')));
    expect(
      payMoment([click(10, 110, bare('n2')), ...typedPairs], type(pairs.at(-1) as string)),
    ).not.toBeNull();
    expect(
      payMoment([click(10, 110, bare('n2')), ...typedPairs.slice(0, -1)], type('99')),
    ).toBeNull();
  });

  test('any split of a card number into one field is caught; no split of a non-card is', () => {
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const luhnSum = (digits: string) =>
      [...digits].reverse().reduce((sum, char, i) => {
        const d = Number(char) * (i % 2 ? 2 : 1);
        return sum + (d > 9 ? d - 9 : d);
      }, 0);
    for (let round = 0; round < 300; round++) {
      let body = String(4 + random(2));
      while (body.length < 15) body += String(random(10));
      const check = (10 - (luhnSum(`${body}0`) % 10)) % 10;
      const card = `${body}${check}`;
      const wrong = `${body}${(check + 1 + random(9)) % 10}`;
      for (const [number, caught] of [
        [card, true],
        [wrong, false],
      ] as const) {
        const pieces: string[] = [];
        for (let at = 0; at < number.length; ) {
          const size = 1 + random(5);
          pieces.push(number.slice(at, at + size));
          at += size;
        }
        const before = [
          click(10, 110, bare('n2')),
          ...pieces
            .slice(0, -1)
            .map((piece) =>
              random(2) ? type(piece, bare('n2')) : keys(piece.split(''), bare('n2')),
            ),
        ];
        const found = payMoment(before, type(pieces.at(-1) as string));
        // A card is caught by the time it is whole, at whichever step completes
        // a number. A non-card is never caught once whole (part-way, its first
        // 13 to 15 digits can be a card's of that length, which is held too).
        const earlier = before.some((_, i) =>
          payMoment(before.slice(0, i), before[i] as ComputerStep),
        );
        expect([number, Boolean(found || (caught && earlier))]).toEqual([number, caught]);
      }
    }
  });

  test('backspace takes a digit back out of what a field holds', () => {
    const before = [click(10, 110, bare('n2')), type('4111111111111112', bare('n2'))];
    expect(payMoment(before.slice(0, 1), before[1] as ComputerStep)).toBeNull();
    expect(
      payMoment(
        before,
        step('computer.batch', {
          actions: [
            { action: 'key', keys: ['BackSpace'] },
            { action: 'type', text: '1' },
          ],
        }),
      ),
    ).not.toBeNull();
    // Without the backspace the field holds 17 digits that are no card's.
    expect(payMoment(before, type('3'))).toBeNull();
  });

  test('a number split across four short fields', () => {
    const fields = ['n2', 'n3', 'n4', 'n5'];
    const before = fields
      .slice(0, 3)
      .flatMap((ref, i) => [
        click(i * 80 + 5, 110, bare(ref)),
        type(i === 0 ? '4111' : '1111', bare(ref)),
      ]);
    expect(payMoment([...before, click(245, 110, bare('n5'))], type('1111'))?.reason).toBe(
      'It types card details.',
    );
    // A phone number and a zip code in short fields are not a card.
    const phone = ['415', '555', '0134', '94110'].map((piece, i) =>
      type(piece, bare(fields[i] as string)),
    );
    expect(payMoment(phone.slice(0, 3), phone[3] as ComputerStep)).toBeNull();
  });

  test('an expiry then a code, one after the other', () => {
    const before = [
      click(5, 110, bare('n2')),
      type('12/27', bare('n2')),
      keys(['Tab'], bare('n3')),
    ];
    expect(payMoment(before, type('737'))?.reason).toBe('It types card details.');
    expect(payMoment(before, type('Hello'))).toBeNull();
  });

  test('sending or clicking on a page where a card was entered is held again', () => {
    const entered = [click(10, 160, checkout('number')), type(VISA, checkout('number'))];
    expect(payMoment(entered, keys(['Return']))?.reason).toBe(
      'It sends a form where card details were entered.',
    );
    // Clicking a button with no pay words still sends the card.
    expect(payMoment(entered, click(350, 270))?.reason).toBe(
      'It clicks on a page where card details were entered.',
    );
    // An unnamed control that is not a button counts too.
    const bareEntered = [click(5, 110, bare('n2')), type(VISA, bare('n2'))];
    expect(payMoment(bareEntered, click(50, 210))).not.toBeNull();
    // Moving on to the next field does not.
    expect(payMoment(entered, click(10, 210))).toBeNull();
    // A new page starts clean.
    const elsewhere = screen('https://news.example.net/', ['n1 button "Read more" box=0,0,100,30']);
    expect(
      payMoment(
        [...entered, step('computer.open', { url: 'https://news.example.net/' }, elsewhere)],
        click(10, 10),
      ),
    ).toBeNull();
  });

  test('a clear pay button on a page with a price, as a saved card pays', () => {
    const moment = payMoment([click(10, 110, checkout())], click(10, 270));
    expect(moment?.reason).toBe('It presses “Pay $24.99” on a page with a price.');
    expect(moment?.site).toBe('shop.example.com');
    expect(moment?.amount).toBe('$24.99');
    const order = screen('https://www.store.example/cart', [
      'n1 text "Subtotal $10.00" box=0,0,200,20',
      'n2 text "Order total $12.50" box=0,30,200,20',
      'n3 button "Place order" box=0,80,200,40',
    ]);
    const placed = payMoment([click(0, 0, order)], click(10, 90));
    expect(placed?.site).toBe('store.example');
    expect(placed?.amount).toBe('$12.50');
    // No price on the page, or a button that does not clearly pay: it goes on.
    const free = screen('https://shop.example.com/signup', ['n1 button "Buy now" box=0,0,200,40']);
    expect(payMoment([click(0, 0, free)], click(10, 10))).toBeNull();
    expect(payMoment([click(10, 110, checkout())], click(350, 270))).toBeNull();
  });

  test('text read off a picture is never used', () => {
    const ocr = screen(
      'https://shop.example.com/checkout',
      ['t1 text "Pay $24.99" box=0,0,300,40', 't2 textbox "Card number" [focused] box=0,50,300,30'],
      'ocr',
    );
    expect(payMoment([click(10, 10, ocr)], click(10, 10))).toBeNull();
    expect(payMoment([click(10, 60, ocr)], type('41'))).toBeNull();
    // A whole card number typed is still caught.
    expect(payMoment([click(10, 60, ocr)], type(VISA))).not.toBeNull();
  });
});

describe('the browser worker', () => {
  test('a card number filled in, or a pay button pressed', () => {
    expect(browserPays('browser.fill', { label: 'Notes', value: VISA })).toBe(
      'It types a card number.',
    );
    expect(browserPays('browser.fill', { label: 'Phone', value: '+1 415 555 0134' })).toBeNull();
    expect(browserPays('browser.click', { role: 'button', name: 'Place order' })).not.toBeNull();
    expect(browserPays('browser.click', { role: 'button', name: 'Pay $24.99' })).not.toBeNull();
    expect(browserPays('browser.click', { role: 'button', name: 'Pay attention' })).toBeNull();
    expect(browserPays('browser.click', { role: 'link', name: 'Payment history' })).toBeNull();
    expect(browserPays('browser.click', { role: 'checkbox', name: 'Buy now' })).toBeNull();
  });
});
