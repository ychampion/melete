/**
 * Replying to one earlier message: Reply on a message holds it above the
 * composer, the x or Escape lets go of it, sending names it as `replies_to`,
 * and a sent reply shows a short quote of what it answered.
 */
import { expect, test } from 'bun:test';
import type { MeleteEvent } from '@melete/client';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { adapter, client } from '../experience/adapter.ts';
import { applyEvent, applyMessageEvent, fromTurns } from '../experience/reduce.ts';
import type { ExperienceEvent, Turn } from '../experience/types.ts';
import { Composer, ReplyChip } from './Composer.tsx';
import { ActionBar, UserBubble } from './parts.tsx';
import {
  cancelsReply,
  personMessageId,
  replyTarget,
  shortQuote,
  shownReply,
  withLocalReply,
} from './reply.ts';

const chatId = 'job_reply';
const at = (second: number) => `2026-10-28T09:00:${String(second).padStart(2, '0')}.000Z`;
const turn = (id: string, text: string, second: number): Turn => ({
  id,
  conversation_id: chatId,
  agent_id: 'nova',
  text,
  answer: '',
  status: 'done',
  delivery: null,
  created_at: at(second),
});
const OPTIONS = 'Two flights work: the 7:40 nonstop, or the 9:15 with one stop in Denver.';
const first = turn('turn_1', 'Find me a flight to Boston on Friday.', 1);
const second = turn('turn_2', 'Book the second one.', 5);

const answer = (seq: number, turnId: string, text: string): ExperienceEvent => ({
  seq,
  turn_id: turnId,
  conversation_id: chatId,
  created_at: at(3),
  item: { type: 'text_delta', text },
});
const personEvent = (
  seq: number,
  saved: Turn,
  extra: Record<string, unknown> = {},
): MeleteEvent => ({
  seq,
  job_id: chatId,
  attempt_id: null,
  type: 'notice',
  payload: { kind: 'user_message', text: saved.text, turn_id: saved.id, ...extra },
  created_at: saved.created_at,
});

/** Both turns answered, with the first person message and answer identified. */
const chat = () => {
  let state = fromTurns([first, second], 'send', 'done');
  state = applyEvent(state, answer(12, first.id, OPTIONS));
  state = applyMessageEvent(state, personEvent(10, first));
  state = applyMessageEvent(state, {
    seq: 12,
    job_id: chatId,
    attempt_id: 'attempt_1',
    type: 'notice',
    payload: {
      kind: 'experience',
      turn_id: first.id,
      item: { type: 'text_delta', text: OPTIONS },
    },
    created_at: at(3),
  });
  return state;
};
const turnOf = (state: ReturnType<typeof chat>, index: number) => {
  const found = state.turns[index];
  if (!found) throw new Error('Missing turn');
  return found;
};

test('Reply sits with the answer actions and with the person message', () => {
  const state = chat();
  const saved = turnOf(state, 0);
  const bar = renderToStaticMarkup(
    <ActionBar turn={saved} touch={false} onCopy={() => {}} onReply={() => {}} />,
  );
  expect(bar).toContain('aria-label="Copy"');
  expect(bar).toContain('aria-label="Reply to this answer"');
  const bubble = renderToStaticMarkup(<UserBubble turn={saved} onReply={() => {}} />);
  expect(bubble).toContain('aria-label="Reply to your message"');
  // With nothing to reply to yet, no control is drawn.
  expect(
    renderToStaticMarkup(<ActionBar turn={saved} touch={false} onCopy={() => {}} />),
  ).not.toContain('Reply');
  expect(renderToStaticMarkup(<UserBubble turn={saved} />)).not.toContain('Reply');
});

test('choosing Reply holds the message, by its id, with a short quote', () => {
  const state = chat();
  const saved = turnOf(state, 0);
  expect(replyTarget(state, saved, 'assistant')).toEqual({
    message_id: '12',
    by: 'assistant',
    text: OPTIONS,
  });
  expect(replyTarget(state, saved, 'person')).toEqual({
    message_id: '10',
    by: 'person',
    text: first.text,
  });
  // A message the job stream has not named yet cannot be replied to.
  expect(replyTarget(state, turnOf(state, 1), 'person')).toBeNull();
  expect(personMessageId(state, turnOf(state, 1))).toBeNull();
});

test('the chip shows above the composer with whose message it is and a way to cancel', () => {
  const html = renderToStaticMarkup(
    <Composer
      value=""
      onChange={() => {}}
      onSend={() => {}}
      reply={{ who: 'Nova', text: OPTIONS }}
      onCancelReply={() => {}}
    />,
  );
  expect(html).toContain('class="composer-reply"');
  expect(html).toContain('Replying to Nova');
  expect(html).toContain(OPTIONS);
  expect(html).toContain('aria-label="Cancel reply"');
  const none = renderToStaticMarkup(
    <Composer value="" onChange={() => {}} onSend={() => {}} reply={null} />,
  );
  expect(none).not.toContain('composer-reply');
});

test('the x and Escape cancel the reply; other keys and no reply do not', () => {
  let cancelled = 0;
  const reply = { who: 'your message', text: first.text };
  const chip = ReplyChip({ reply, onCancel: () => cancelled++ });
  const kids = (chip.props as { children: ReactElement[] }).children;
  const x = kids.find((kid) => (kid.props as { label?: string }).label === 'Cancel reply');
  if (!x) throw new Error('Missing the x');
  (x.props as { onClick: () => void }).onClick();
  expect(cancelled).toBe(1);
  const onKeyDown = (chip.props as { onKeyDown: (event: unknown) => void }).onKeyDown;
  onKeyDown({ key: 'Escape', preventDefault() {} });
  expect(cancelled).toBe(2);
  onKeyDown({ key: 'a', preventDefault() {} });
  expect(cancelled).toBe(2);
  expect(renderToStaticMarkup(chip)).toContain('Replying to your message');
  // The box lets go on Escape only while a reply is held.
  expect(cancelsReply('Escape', true)).toBe(true);
  expect(cancelsReply('Escape', false)).toBe(false);
  expect(cancelsReply('Enter', true)).toBe(false);
});

test('sending a reply names the earlier message as replies_to', async () => {
  const bodies: unknown[] = [];
  // Every request is answered here, and its body kept, before it leaves the client.
  const capture = {
    async onRequest({ request }: { request: Request }) {
      bodies.push(await request.clone().json());
      return Response.json({}, { status: 202 });
    },
  };
  client.api.use(capture);
  try {
    await adapter.send(chatId, 'Book the second one.', 'key_1', [], [], '12');
    await adapter.send(chatId, 'Thanks.', 'key_2');
  } finally {
    client.api.eject(capture);
  }
  expect(bodies[0]).toMatchObject({ text: 'Book the second one.', replies_to: '12' });
  expect(bodies[1]).not.toHaveProperty('replies_to');
});

test('a sent reply shows the quote the service kept on its event', () => {
  const quote = { message_id: '12', by: 'assistant', text: 'Two flights work: the 7:40' };
  const state = applyMessageEvent(
    chat(),
    personEvent(20, second, { replies_to: '12', reply_quote: quote }),
  );
  const saved = turnOf(state, 1);
  expect(shownReply(state, saved)).toEqual(quote as never);
  const html = renderToStaticMarkup(<UserBubble turn={saved} quote={shownReply(state, saved)} />);
  expect(html).toContain('class="reply-quote"');
  expect(html).toContain('In reply to the agent:');
  expect(html).toContain('Two flights work: the 7:40');
});

test('without a kept quote, the target words come from the transcript, cut short', () => {
  const long = `${OPTIONS} ${'Both leave from Terminal B and land before noon. '.repeat(6)}`;
  let state = fromTurns([first, second], 'send', 'done');
  state = applyMessageEvent(state, personEvent(10, { ...first, text: long }));
  // Only the id came with the reply's event.
  state = applyMessageEvent(state, personEvent(20, second, { replies_to: '10' }));
  const shown = shownReply(state, turnOf(state, 1));
  expect(shown?.message_id).toBe('10');
  expect(shown?.by).toBe('person');
  expect(shown?.text).toBe(shortQuote(first.text));

  // A reply sent here shows at once, before the job stream names it.
  let local = fromTurns([first, second], 'send', 'done');
  local = applyEvent(local, answer(12, first.id, long));
  local = applyMessageEvent(local, {
    seq: 12,
    job_id: chatId,
    attempt_id: 'attempt_1',
    type: 'notice',
    payload: { kind: 'experience', turn_id: first.id, item: { type: 'text_delta', text: long } },
    created_at: at(3),
  });
  local = withLocalReply(local, second.id, { message_id: '12', by: 'assistant', text: 'old' });
  const drawn = shownReply(local, turnOf(local, 1));
  expect(drawn?.text).toBe(shortQuote(long));
  expect(drawn?.text.length).toBeLessThanOrEqual(140);
  expect(drawn?.text.endsWith('…')).toBe(true);
});

test('a message that replied to nothing shows no quote', () => {
  const state = chat();
  expect(shownReply(state, turnOf(state, 0))).toBeNull();
  expect(renderToStaticMarkup(<UserBubble turn={turnOf(state, 0)} />)).not.toContain('reply-quote');
});
