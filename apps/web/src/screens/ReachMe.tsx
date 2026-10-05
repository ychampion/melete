/**
 * Texts and calls about deadlines the person set: their own number, proved
 * once with a code, and their one-time agreement, shown in the words that are
 * recorded with it. Without a telephony provider on this installation, it
 * says plainly that Melete reaches them by push only.
 */
import { useState } from 'react';
import { Button, Input } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useLoad } from '../experience/hooks.ts';
import type { ReachState } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

const dateOf = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** What the person agreed to, in a few words. */
export function agreementLine(consent: NonNullable<ReachState['consent']>): string {
  const parts = ['texts', consent.calls ? 'then a call' : null].filter(Boolean).join(', ');
  return `On: ${parts}${consent.nights ? ', at night too' : ', only during your day'}. You agreed on ${dateOf(
    consent.agreed_at,
  )}.`;
}

const CHANNEL = { push: 'Push', text: 'Text', call: 'Call' } as const;

function Row({ title, sub, children }: { title: string; sub: string; children?: React.ReactNode }) {
  return (
    <div
      className="list-row"
      style={{ minHeight: 60, flexWrap: 'wrap', rowGap: 8, paddingTop: 10, paddingBottom: 10 }}
    >
      <div className="col grow" style={{ gap: 2, minWidth: 200 }}>
        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>{title}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{sub}</span>
      </div>
      {children}
    </div>
  );
}

export function ReachMe() {
  const state = useLoad(() => adapter.reach(), []);
  const [number, setNumber] = useState('');
  const [code, setCode] = useState('');
  const [calls, setCalls] = useState(true);
  const [nights, setNights] = useState(false);
  const [busy, setBusy] = useState(false);
  const reach = state.data?.reach;

  const act = async (
    work: () => ReturnType<typeof adapter.reach>,
    done: string,
    after?: () => void,
  ) => {
    setBusy(true);
    const r = await work();
    setBusy(false);
    if (r.data === null) {
      toast({ kind: 'err', title: r.error ?? r.unavailable ?? 'Couldn’t do that' });
      return;
    }
    state.set(r.data);
    after?.();
    toast({ kind: 'ok', title: done });
  };

  if (!reach) return null;
  const pending = reach.pending_number;
  const wording = [
    reach.wording.texts,
    calls ? reach.wording.calls : null,
    nights ? reach.wording.nights : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section className="col" style={{ gap: 8, marginTop: 8 }} aria-labelledby="reach-head">
      <h2 id="reach-head" style={{ fontSize: 13, fontWeight: 600, color: 'var(--heading)' }}>
        Texts and calls about your deadlines
      </h2>
      <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
        When a deadline you set is about to be missed and you haven’t opened its push, Melete can
        text your own number three minutes later, and call it five minutes after that. It stops as
        soon as you open the push, reply, or press a key on the call.
      </p>

      {!reach.available ? (
        <p role="status" style={{ fontSize: 13, color: 'var(--secondary)', maxWidth: 560 }}>
          {reach.unavailable_reason}
        </p>
      ) : (
        <div className="card-12" style={{ overflow: 'hidden' }}>
          <div style={{ height: 1 }} />
          {reach.number && !pending ? (
            <Row
              title={reach.number}
              sub={`Your number, verified${reach.verified_at ? ` ${dateOf(reach.verified_at)}` : ''}. Texts and calls come from ${reach.from_number ?? 'Melete’s number'}.`}
            >
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void act(() => adapter.reachForget(), 'Your number is removed')}
              >
                Remove number
              </Button>
            </Row>
          ) : null}

          {pending ? (
            <Row
              title={`Enter the code sent to ${pending}`}
              sub="It lasts 10 minutes. Codes are six digits."
            >
              <form
                className="row"
                style={{ gap: 8, flexWrap: 'wrap' }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(
                    () => adapter.reachVerify(code.trim()),
                    'Your number is verified',
                    () => setCode(''),
                  );
                }}
              >
                <Input
                  aria-label="Code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  maxLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  width={120}
                />
                <Button size="sm" type="submit" disabled={busy || code.trim().length !== 6}>
                  Verify
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void act(() => adapter.reachSendCode(pending), 'A new code is on its way')
                  }
                >
                  Send again
                </Button>
              </form>
            </Row>
          ) : (
            <Row
              title={reach.number ? 'Use another number' : 'Your number'}
              sub="With + and the country code. Melete texts it a code to make sure it’s yours."
            >
              <form
                className="row"
                style={{ gap: 8, flexWrap: 'wrap' }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(
                    () => adapter.reachSendCode(number.replace(/[\s()-]/g, '')),
                    'A code is on its way',
                    () => setNumber(''),
                  );
                }}
              >
                <Input
                  aria-label="Phone number"
                  type="tel"
                  autoComplete="tel"
                  placeholder="+1 415 555 0100"
                  value={number}
                  onChange={(event) => setNumber(event.target.value)}
                  width={180}
                />
                <Button size="sm" variant="outline" type="submit" disabled={busy || !number.trim()}>
                  Text me a code
                </Button>
              </form>
            </Row>
          )}

          {reach.opted_out_at ? (
            <Row
              title="You replied STOP"
              sub={`Nothing is texted or called. To allow it again, text START to ${reach.from_number ?? 'Melete’s number'}, then agree below.`}
            />
          ) : null}

          {reach.number && reach.consent ? (
            <Row title="Texts and calls are on" sub={agreementLine(reach.consent)}>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void act(() => adapter.reachWithdraw(), 'Texts and calls are off')}
              >
                Turn off
              </Button>
            </Row>
          ) : null}

          {reach.number && !reach.consent && !reach.opted_out_at ? (
            <div className="col" style={{ gap: 10, padding: '12px 16px' }}>
              <label className="row" style={{ gap: 8, fontSize: 14, color: 'var(--heading)' }}>
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={calls}
                  onChange={(event) => setCalls(event.target.checked)}
                />
                Call me if a text goes unanswered too
              </label>
              <label className="row" style={{ gap: 8, fontSize: 14, color: 'var(--heading)' }}>
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={nights}
                  onChange={(event) => setNights(event.target.checked)}
                />
                Also outside my day hours
              </label>
              <p
                style={{ fontSize: 13, color: 'var(--secondary)', maxWidth: 600 }}
                id="reach-wording"
              >
                {wording}
              </p>
              <div>
                <Button
                  aria-describedby="reach-wording"
                  disabled={busy}
                  onClick={() =>
                    void act(() => adapter.reachAgree({ calls, nights }), 'Texts and calls are on')
                  }
                >
                  Agree and turn on
                </Button>
              </div>
            </div>
          ) : null}

          {reach.number ? (
            <Row
              title="Today"
              sub={`${reach.today.texts} of ${reach.today.text_cap} texts and ${reach.today.calls} of ${reach.today.call_cap} calls.`}
            />
          ) : null}
        </div>
      )}

      {reach.recent.some((contact) => contact.purpose === 'ladder') ? (
        <>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--heading)', marginTop: 8 }}>
            What Melete did
          </span>
          <ul className="card-12" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {reach.recent
              .filter((contact) => contact.purpose === 'ladder')
              .slice(0, 6)
              .map((contact) => (
                <li key={contact.id} className="list-row" style={{ minHeight: 48 }}>
                  <div className="col grow" style={{ gap: 2 }}>
                    <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
                      {CHANNEL[contact.channel]} · {contact.state}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>{contact.reason}</span>
                  </div>
                </li>
              ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
