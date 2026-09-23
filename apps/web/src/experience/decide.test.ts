/**
 * One decision sends one request. Home's cards, chat's permission card, chat's
 * question and the phone's bar all read keys through `decisionKey` and send
 * through `InFlight.run`, so these drive the same two pieces with the presses a
 * person makes: Enter held down, a number pressed twice, a double tap.
 */
import { expect, test } from 'bun:test';
import { type CardKeys, decisionKey, InFlight, type KeyPress } from './decide.ts';

const onCard = (key: string): KeyPress => ({ key, onCard: true, inField: false });
const PERMISSION: CardKeys = { allow: true, deny: true, read: true };
const QUESTION: CardKeys = {
  options: [{ id: 'hold' }, { id: 'others' }, { id: 'later' }],
  own: true,
  read: true,
};

/** A service call that stays open until `settle` is called, counting what was sent. */
function service() {
  const sent: string[] = [];
  let settle: (ok: boolean) => void = () => {};
  const post = (what: string) => () => {
    sent.push(what);
    return new Promise<void>((resolve, reject) => {
      settle = (ok) => (ok ? resolve() : reject(new Error('refused')));
    });
  };
  return { sent, post, settle: (ok = true) => settle(ok) };
}

/** What a card does with a key, the way the screens route it. */
function press(
  flight: InFlight,
  id: string,
  card: CardKeys,
  key: KeyPress,
  post: () => Promise<void>,
) {
  const intent = decisionKey(key, card);
  if (intent && intent.kind !== 'read' && intent.kind !== 'own')
    void flight.run(id, post)?.catch(() => {});
}

test('Enter pressed three times on a focused permission card sends one decision', () => {
  const flight = new InFlight();
  const api = service();
  for (let i = 0; i < 3; i++)
    press(flight, 'permission_1', PERMISSION, onCard('Enter'), api.post('allow_once'));
  expect(api.sent).toEqual(['allow_once']);
  expect(flight.has('permission_1')).toBe(true);
});

test('"3" pressed twice on a question sends one answer', () => {
  const flight = new InFlight();
  const api = service();
  press(flight, 'q_1', QUESTION, onCard('3'), api.post('later'));
  press(flight, 'q_1', QUESTION, onCard('3'), api.post('later'));
  expect(api.sent).toEqual(['later']);
});

test('a double tap on Allow once sends one decision', () => {
  const flight = new InFlight();
  const api = service();
  const tap = () => void flight.run('permission_1', api.post('allow_once'));
  tap();
  tap();
  expect(api.sent).toEqual(['allow_once']);
});

test('a decision that failed can be tried again once the first answer is back', async () => {
  const flight = new InFlight();
  const api = service();
  const first = flight.run('permission_1', api.post('allow_once'));
  api.settle(false);
  await first?.catch(() => {});
  expect(flight.has('permission_1')).toBe(false);
  const again = flight.run('permission_1', api.post('allow_once'));
  expect(again).not.toBeNull();
  expect(api.sent).toEqual(['allow_once', 'allow_once']);
});

test('two different decisions are not held up by each other', () => {
  const flight = new InFlight();
  const api = service();
  void flight.run('permission_1', api.post('one'));
  void flight.run('permission_2', api.post('two'));
  expect(api.sent).toEqual(['one', 'two']);
});

test('Enter allows only when the card itself has focus, never from a button or a field', () => {
  expect(decisionKey(onCard('Enter'), PERMISSION)).toEqual({ kind: 'allow' });
  expect(decisionKey({ key: 'Enter', onCard: false, inField: false }, PERMISSION)).toBeNull();
  expect(decisionKey({ key: 'd', onCard: false, inField: true }, PERMISSION)).toBeNull();
  expect(decisionKey({ key: 'd', onCard: false, inField: false }, PERMISSION)).toEqual({
    kind: 'deny',
  });
  expect(decisionKey({ ...onCard('d'), metaKey: true }, PERMISSION)).toBeNull();
});

test('a question answers its number keys, and the key after them opens its own answer', () => {
  expect(decisionKey(onCard('2'), QUESTION)).toEqual({ kind: 'answer', optionId: 'others' });
  expect(decisionKey(onCard('4'), QUESTION)).toEqual({ kind: 'own' });
  expect(decisionKey(onCard('5'), QUESTION)).toBeNull();
  expect(decisionKey(onCard('Enter'), QUESTION)).toBeNull();
});
