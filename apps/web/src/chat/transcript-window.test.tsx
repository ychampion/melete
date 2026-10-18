/**
 * A long transcript draws only near the view. Turns far from it are space of
 * their height, so a chat of two thousand messages with long tool output
 * costs about what its newest turns do to draw; a short chat draws whole.
 */
import { expect, test } from 'bun:test';
import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OlderTurns, TurnSlot, UNDRAWN_HEIGHT, WINDOW_FROM } from './TranscriptWindow.tsx';

const root = createRef<HTMLDivElement>();
const OUTPUT = 'x'.repeat(120_000);

/** A thousand turns, each with a long tool output, drawn as the chat screen draws them. */
function transcript(turns: number) {
  const windowed = turns > WINDOW_FROM;
  return renderToStaticMarkup(
    <div className="chat-messages">
      {Array.from({ length: turns }, (_, index) => (
        <TurnSlot
          // biome-ignore lint/suspicious/noArrayIndexKey: the fixture's turns never move
          key={index}
          turnId={`turn_${index}`}
          root={root}
          windowed={windowed}
          near={index >= turns - WINDOW_FROM}
        >
          <div className="turn" data-turn={`turn_${index}`}>
            <pre>{OUTPUT}</pre>
          </div>
        </TurnSlot>
      ))}
    </div>,
  );
}

test('a long transcript draws its newest turns and holds the room of the rest', () => {
  const started = performance.now();
  const html = transcript(1000);
  const took = performance.now() - started;
  expect(html.match(/data-turn=/g)?.length).toBe(WINDOW_FROM);
  expect(html.match(/data-drawn="false"/g)?.length).toBe(1000 - WINDOW_FROM);
  expect(html).toContain(`height:${UNDRAWN_HEIGHT}px`);
  // The page holds the output of the drawn turns only, never all thousand.
  expect(html.length).toBeLessThan((WINDOW_FROM + 1) * OUTPUT.length);
  expect(took).toBeLessThan(2000);
  // The newest turn is drawn.
  expect(html).toContain('data-turn="turn_999"');
  expect(html).not.toContain('data-turn="turn_0"');
});

test('a short transcript draws every turn', () => {
  const html = transcript(WINDOW_FROM);
  expect(html.match(/data-turn=/g)?.length).toBe(WINDOW_FROM);
  expect(html).not.toContain('data-drawn');
});

test('the start of what was read is a button: read more, reading, or try again', () => {
  const idle = renderToStaticMarkup(
    <OlderTurns root={root} loading={false} error={null} onLoad={() => {}} />,
  );
  expect(idle).toContain('<button type="button" class="previous-messages"');
  expect(idle).toContain('Earlier messages');
  const reading = renderToStaticMarkup(
    <OlderTurns root={root} loading error={null} onLoad={() => {}} />,
  );
  expect(reading).toContain('aria-busy="true"');
  // Reading leaves the button focusable, so the keyboard's place is kept.
  expect(reading).not.toContain('disabled=""');
  expect(reading).toContain('aria-disabled="true"');
  const failed = renderToStaticMarkup(
    <OlderTurns root={root} loading={false} error="Offline" onLoad={() => {}} />,
  );
  expect(failed).toContain('Try again');
});

test('a turn far from the view keeps its words, so find in page and screen readers reach it', () => {
  const html = renderToStaticMarkup(
    <TurnSlot
      turnId="turn_1"
      words={{ asked: 'Step 3: run the checks', answered: 'The build is green.' }}
      root={root}
      windowed
      near={false}
    >
      <div className="turn" data-turn="turn_1">
        <pre>{OUTPUT}</pre>
      </div>
    </TurnSlot>,
  );
  expect(html).toContain('data-drawn="false"');
  expect(html).toContain('<p>Step 3: run the checks</p>');
  expect(html).toContain('<p>The build is green.</p>');
  expect(html).not.toContain(OUTPUT.slice(0, 100));
});
