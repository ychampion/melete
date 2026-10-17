/**
 * A call's turns against a fake ElevenLabs (the upstream messages are written
 * here as it sends them) and a fake chat whose turns the test moves along.
 */
import { describe, expect, test } from 'bun:test';
import type { UpstreamReply } from '../connectors/speech-engine.ts';
import {
  CALL_WORDS,
  type CallChat,
  CallSession,
  type CallTiming,
  type CallTurn,
  type CallWaiting,
} from './session.ts';

type Sent = Extract<UpstreamReply, { type: 'agent_response' }>;

/** A chat the test drives: turns it can move along, and everything the call asked of it. */
function fakeChat() {
  const turns = new Map<string, CallTurn>();
  const said: string[] = [];
  const controls: string[] = [];
  let running: string | null = null;
  let waiting: CallWaiting | null = null;
  let next = 0;
  const chat: CallChat = {
    async say(text) {
      said.push(text);
      if (running) return { turnId: running };
      const id = `turn_${++next}`;
      turns.set(id, { status: 'working', answer: '' });
      running = id;
      return { turnId: id };
    },
    running: async () => running,
    turn: async (id) => turns.get(id) ?? null,
    waiting: async () => waiting,
    control: async (command) => {
      controls.push(command);
    },
  };
  return {
    chat,
    said,
    controls,
    write(id: string, answer: string, status = 'streaming') {
      turns.set(id, { status, answer });
      if (status === 'done' || status === 'failed' || status === 'needs_you')
        running = running === id ? null : running;
    },
    wait(value: CallWaiting | null) {
      waiting = value;
    },
    turn: (id: string) => turns.get(id),
  };
}

/** The link to ElevenLabs, faked: what was sent, and whether it was closed. */
function fakeLink() {
  const sent: UpstreamReply[] = [];
  let closed = false;
  return {
    link: { send: (reply: UpstreamReply) => sent.push(reply), close: () => (closed = true) },
    sent,
    responses: () => sent.filter((reply): reply is Sent => reply.type === 'agent_response'),
    spoken: (eventId?: number) =>
      sent
        .filter(
          (reply): reply is Sent =>
            reply.type === 'agent_response' &&
            (eventId === undefined || reply.event_id === eventId),
        )
        .map((reply) => reply.content.trim())
        .filter(Boolean),
    finals: (eventId: number) =>
      sent.filter(
        (reply) => reply.type === 'agent_response' && reply.is_final && reply.event_id === eventId,
      ).length,
    get closed() {
      return closed;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

// The filler waits long enough that a test writing the answer at once is never beaten to it.
const QUICK = { pollMs: 2, fillerMs: 600, stillMs: 10_000, holdMs: 10_000 };
const init = (id = 'conv_1') => JSON.stringify({ type: 'init', conversation_id: id });
const heard = (eventId: number, ...history: [string, string][]) =>
  JSON.stringify({
    type: 'user_transcript',
    event_id: eventId,
    user_transcript: history.map(([role, content]) => ({ role, content })),
  });

function call(fake = fakeChat(), timing: Partial<CallTiming> = QUICK) {
  const link = fakeLink();
  const session = new CallSession(
    link.link,
    async (id) => (id === 'conv_1' ? fake.chat : null),
    timing,
  );
  return { fake, link, session };
}

describe('a call speaks into the chat', () => {
  test('what is said becomes a message, and the answer is read aloud as it is written', async () => {
    const { fake, link, session } = call();
    await session.receive(init());
    const answering = session.receive(heard(1, ['user', 'What is on today?']));
    await until(() => fake.said.length === 1, 'the message');
    expect(fake.said).toEqual(['What is on today?']);
    fake.write('turn_1', 'You have a dentist appointment at three. ');
    await until(() => link.spoken(1).length > 0, 'the first sentence');
    fake.write(
      'turn_1',
      'You have a dentist appointment at three. Then **dinner** with Sam.',
      'done',
    );
    await answering;
    expect(link.spoken(1)).toEqual([
      'You have a dentist appointment at three.',
      'Then dinner with Sam.',
    ]);
    expect(link.finals(1)).toBe(1);
  });

  test('while the agent works with nothing to say yet, the call says so', async () => {
    const { fake, link, session } = call();
    await session.receive(init());
    const answering = session.receive(heard(1, ['user', 'Find me a flight to Lisbon']));
    await until(() => link.spoken(1).includes(CALL_WORDS.filler), 'the filler');
    fake.write('turn_1', 'The cheapest is on Friday.', 'done');
    await answering;
    expect(link.spoken(1)).toEqual([CALL_WORDS.filler, 'The cheapest is on Friday.']);
  });

  test('talking over the answer stops it: nothing more is sent for the old turn event', async () => {
    const { fake, link, session } = call();
    await session.receive(init());
    const first = session.receive(heard(1, ['user', 'Read me my emails']));
    await until(() => fake.said.length === 1, 'the message');
    fake.write('turn_1', 'The first is from Ana about the lease. ');
    await until(() => link.spoken(1).length === 1, 'the first sentence');
    // The person talks over it while the agent is still writing.
    const second = session.receive(
      heard(
        2,
        ['user', 'Read me my emails'],
        ['agent', 'The first is from Ana'],
        ['user', 'Skip that one'],
      ),
    );
    await first;
    fake.write(
      'turn_1',
      'The first is from Ana about the lease. The second is from the bank.',
      'done',
    );
    await second;
    // The old event got nothing after the interruption, and was never finished by this side.
    expect(link.spoken(1)).toEqual(['The first is from Ana about the lease.']);
    expect(link.finals(1)).toBe(0);
    // What was said over it went to the running turn, not into a new one, and the work was not stopped.
    expect(fake.said).toEqual(['Read me my emails', 'Skip that one']);
    expect(fake.controls).toEqual([]);
    expect(link.spoken(2)).toEqual([CALL_WORDS.passedOn, 'The second is from the bank.']);
    expect(link.finals(2)).toBe(1);
  });

  test('hanging up ends the call and leaves the work running', async () => {
    const { fake, link, session } = call();
    await session.receive(init());
    const answering = session.receive(heard(1, ['user', 'Research the best e-bikes']));
    await until(() => link.spoken(1).includes(CALL_WORDS.filler), 'the filler');
    session.closedByPeer();
    await answering;
    const sentBefore = link.sent.length;
    fake.write('turn_1', 'Here are three e-bikes.', 'done');
    await tick();
    // Nothing is sent to a closed call, and nothing stopped the work.
    expect(link.sent.length).toBe(sentBefore);
    expect(fake.controls).toEqual([]);
    expect(fake.turn('turn_1')?.status).toBe('done');
  });

  test('a decision is asked out loud and waits on the screen; the answer after it is still read', async () => {
    const { fake, link, session } = call();
    await session.receive(init());
    const answering = session.receive(heard(1, ['user', 'Email Sam that I am late']));
    fake.wait({ kind: 'approval', key: 'apr_1' });
    await until(() => link.spoken(1).includes(CALL_WORDS.approval), 'the approval line');
    fake.wait(null);
    fake.write('turn_1', 'Sent it to Sam.', 'done');
    await answering;
    expect(link.spoken(1).filter((words) => words === CALL_WORDS.approval)).toHaveLength(1);
    expect(link.spoken(1).at(-1)).toBe('Sent it to Sam.');
  });

  test('a long wait on a decision is never quiet past the reminder interval, and is handed back after a few reminders', async () => {
    const { fake, link, session } = call(fakeChat(), {
      ...QUICK,
      waitMs: 40,
      waitReminders: 2,
    });
    await session.receive(init());
    const answering = session.receive(heard(1, ['user', 'Book the table for eight']));
    await until(() => fake.said.length === 1, 'the message');
    fake.wait({ kind: 'approval', key: 'apr_9' });
    await answering;
    // Announced once, reminded twice, then left on the screen: the response ends.
    expect(link.spoken(1)).toEqual([
      CALL_WORDS.approval,
      CALL_WORDS.approvalStill[0],
      CALL_WORDS.approvalStill[1],
      CALL_WORDS.approvalLeft,
    ]);
    expect(link.finals(1)).toBe(1);
    // The provider re-engaging the quiet line hears once where it is, and no reminders start again.
    await session.receive(
      heard(2, ['user', 'Book the table for eight'], ['agent', CALL_WORDS.approvalLeft]),
    );
    expect(link.spoken(2)).toEqual([CALL_WORDS.stillOnScreen]);
    expect(link.finals(2)).toBe(1);
    // The work was left waiting, not stopped.
    expect(fake.controls).toEqual([]);
  });

  test('reminders come at the interval, and the answer after the decision is read', async () => {
    const stamps: number[] = [];
    const fake = fakeChat();
    const { link, session } = call(fake, {
      ...QUICK,
      waitMs: 30,
      waitReminders: 10,
    });
    const send = link.link.send;
    link.link.send = (reply) => {
      if (reply.type === 'agent_response' && reply.content) stamps.push(Date.now());
      return send(reply);
    };
    await session.receive(init());
    const answering = session.receive(heard(1, ['user', 'Pay the electricity bill']));
    await until(() => fake.said.length === 1, 'the message');
    fake.wait({ kind: 'question', key: 'q_1', text: 'Which card?' });
    await until(() => link.spoken(1).length >= 3, 'two reminders');
    fake.wait(null);
    fake.write('turn_1', 'Paid with the Visa.', 'done');
    await answering;
    const spoken = link.spoken(1);
    expect(spoken[0]).toBe(`${CALL_WORDS.question} Which card?`);
    expect(spoken[1]).toBe(CALL_WORDS.questionStill[0]);
    expect(spoken.at(-1)).toBe('Paid with the Visa.');
    expect(spoken).not.toContain(CALL_WORDS.questionLeft);
    // No gap between the words said while waiting is much longer than the interval.
    const waits = stamps.slice(0, 3);
    for (let i = 1; i < waits.length; i++)
      expect((waits[i] ?? 0) - (waits[i - 1] ?? 0)).toBeLessThan(30 + 100);
  });

  test('"stop" while the work runs works the stop control at once', async () => {
    const { fake, link, session } = call();
    await session.receive(init());
    const answering = session.receive(heard(1, ['user', 'Plan my week']));
    await until(() => fake.said.length === 1, 'the message');
    const stopping = session.receive(heard(2, ['user', 'Plan my week'], ['user', 'Stop.']));
    await stopping;
    await answering;
    expect(fake.controls).toEqual(['stop']);
    expect(link.spoken(2)).toEqual([CALL_WORDS.stopping]);
    expect(fake.said).toEqual(['Plan my week']);
  });

  test('a quick question while the work runs is answered by the companion, and the work goes on', async () => {
    const fake = fakeChat();
    fake.chat.aside = async () => ({ intent: 'talk', say: 'I have read two of the three pages.' });
    const { link, session } = call(fake);
    await session.receive(init());
    const answering = session.receive(heard(1, ['user', 'Compare these three laptops']));
    await until(() => fake.said.length === 1, 'the message');
    const asking = session.receive(
      heard(2, ['user', 'Compare these three laptops'], ['user', 'How is it going?']),
    );
    await until(() => link.spoken(2).length === 1, 'the aside');
    fake.write('turn_1', 'The second laptop is best.', 'done');
    await asking;
    await answering;
    expect(link.spoken(2)).toEqual([
      'I have read two of the three pages.',
      'The second laptop is best.',
    ]);
    expect(fake.said).toEqual(['Compare these three laptops']);
  });

  test('a corrected transcript of the same words is not a second message', async () => {
    const { fake, link, session } = call();
    await session.receive(init());
    const first = session.receive(heard(46, ['user', 'Hi. Please open example.com']));
    await until(() => fake.said.length === 1, 'the message');
    // ElevenLabs sends the same utterance again, transcribed a little differently.
    const corrected = session.receive(heard(52, ['user', 'Hi, please open example.com']));
    await first;
    fake.write('turn_1', 'The heading is Example Domain.', 'done');
    await corrected;
    expect(fake.said).toEqual(['Hi. Please open example.com']);
    expect(fake.controls).toEqual([]);
    expect(link.spoken(52).at(-1)).toBe('The heading is Example Domain.');
    expect(link.finals(52)).toBe(1);
  });

  test('an event asked for again carries the answer on; an older one asked again is dropped', async () => {
    const { fake, link, session } = call();
    await session.receive(init());
    const first = session.receive(heard(5, ['user', 'Research e-bikes']));
    await until(() => link.spoken(5).includes(CALL_WORDS.filler), 'the filler');
    // The provider heard nothing more in time and asks again, with what was spoken so far.
    const again = session.receive(
      heard(5, ['user', 'Research e-bikes'], ['agent', CALL_WORDS.filler]),
    );
    await first;
    await session.receive(heard(4, ['user', 'Research e-bikes']));
    fake.write('turn_1', 'Three stand out.', 'done');
    await again;
    expect(fake.said).toEqual(['Research e-bikes']);
    expect(link.spoken(5).filter((words) => words === CALL_WORDS.filler)).toHaveLength(1);
    expect(link.spoken(5).at(-1)).toBe('Three stand out.');
    expect(link.finals(4)).toBe(0);
  });

  test('a transcript of a noise is not sent to the chat', async () => {
    const { fake, link, session } = call();
    await session.receive(init());
    await session.receive(heard(3, ['user', '...']));
    expect(fake.said).toEqual([]);
    expect(link.finals(3)).toBe(1);
  });

  test('a call nobody started here is not taken', async () => {
    const { fake, link, session } = call();
    await session.receive(init('conv_unknown'));
    expect(link.closed).toBe(true);
    await session.receive(heard(1, ['user', 'Hello?']));
    expect(fake.said).toEqual([]);
  });

  test('pings are answered, and nothing new from the person gets an empty answer', async () => {
    const { link, session } = call();
    await session.receive(JSON.stringify({ type: 'ping', event_id: 3 }));
    expect(link.sent).toEqual([{ type: 'pong' }]);
    await session.receive(init());
    await session.receive(heard(4, ['user', 'Hi'], ['agent', 'Hello!']));
    expect(link.responses()).toEqual([
      { type: 'agent_response', content: '', event_id: 4, is_final: true },
    ]);
  });
});
