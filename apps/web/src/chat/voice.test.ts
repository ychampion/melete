import { describe, expect, test } from 'bun:test';
import { base64, downsample, elapsed, microphoneProblem, nextPiece, speakable } from './voice.ts';

describe('microphone audio for the realtime session', () => {
  test('48 kHz floats become 16 kHz 16-bit samples, averaged', () => {
    const input = new Float32Array([1, 1, 1, 0, 0, 0, -1, -1, -1]);
    expect(Array.from(downsample(input, 48_000, 16_000))).toEqual([32767, 0, -32768]);
  });

  test('samples are clipped rather than wrapped', () => {
    expect(Array.from(downsample(new Float32Array([2, -2]), 16_000, 16_000))).toEqual([
      32767, -32768,
    ]);
  });

  test('base64 is the little-endian bytes of the samples', () => {
    expect(base64(new Int16Array([1, -1]))).toBe(btoa(String.fromCharCode(1, 0, 255, 255)));
  });
});

describe('a reply read aloud', () => {
  test('Markdown marks, links and code are not read out', () => {
    expect(
      speakable(
        '## Plan\n- **Call** the [dentist](https://example.test/x) at 9\n```js\nx()\n```\nSee https://example.test',
      ),
    ).toBe('Plan Call the dentist at 9 There is code on the screen. See a link');
  });

  test('pieces end at finished sentences, and the rest waits unless the reply is done', () => {
    const text =
      'Your afternoon is free after two, and the dentist is on Friday at half past four. Shall I move it? Also';
    const first = nextPiece(text, 0, false);
    expect(first?.piece).toBe(
      'Your afternoon is free after two, and the dentist is on Friday at half past four.',
    );
    const second = nextPiece(text, first?.end ?? 0, false);
    expect(second?.piece).toBe('Shall I move it?');
    expect(nextPiece(text, second?.end ?? 0, false)).toBeNull();
    expect(nextPiece(text, second?.end ?? 0, true)?.piece).toBe('Also');
    expect(nextPiece(text, text.length, true)).toBeNull();
  });

  test('short sentences are read together, so speech is not chopped into fragments', () => {
    expect(nextPiece('Yes. Done. Anything else?', 0, false)?.piece).toBe(
      'Yes. Done. Anything else?',
    );
  });

  test('a long sentence is cut at a space so no piece passes the limit', () => {
    const long = Array.from({ length: 120 }, () => 'word').join(' ');
    const piece = nextPiece(long, 0, false);
    expect(piece?.piece.length).toBeLessThanOrEqual(400);
    expect(piece?.piece.endsWith('word')).toBe(true);
  });
});

describe('plain words for the person', () => {
  test('a refused microphone says what to do', () => {
    const denied = Object.assign(new Error('x'), { name: 'NotAllowedError' });
    expect(microphoneProblem(denied)).toBe(
      'Melete can’t use your microphone. Allow it for this site in your browser, then try again.',
    );
    expect(microphoneProblem(Object.assign(new Error('x'), { name: 'NotFoundError' }))).toBe(
      'No microphone was found. Connect one and try again.',
    );
  });

  test('a running recording reads as minutes and seconds', () => {
    expect(elapsed(0)).toBe('0:00');
    expect(elapsed(7_900)).toBe('0:07');
    expect(elapsed(119_000)).toBe('1:59');
  });
});
