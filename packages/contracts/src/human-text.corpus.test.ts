/**
 * The pass over a corpus of real replies, when one is given.
 *
 * Set `MELETE_REPLY_CORPUS` to a directory of JSON files (bench or eval
 * results). Every string under a reply-like key is read as a reply. Nothing
 * from the corpus is written anywhere; the test only counts and checks:
 *
 * - the shown text equals the whole-text output however the reply is split;
 * - fenced code comes out byte for byte;
 * - no reply is left empty;
 * - no dash used as punctuation is left in an English sentence outside the
 *   regions the pass protects.
 *
 * Without the variable, the test is skipped.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HumanText, humanText } from './human-text.ts';

const DIRECTORY = process.env.MELETE_REPLY_CORPUS;
const KEYS = new Set(['answer', 'reply', 'final_answer', 'response', 'summary', 'draft']);

function files(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) found.push(...files(path));
    else if (name.endsWith('.json') && stat.size < 20_000_000) found.push(path);
  }
  return found;
}

function replies(value: unknown, into: Set<string>, key = ''): void {
  if (typeof value === 'string') {
    if (KEYS.has(key) && value.trim().length >= 20) into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) replies(item, into, key);
    return;
  }
  if (value && typeof value === 'object')
    for (const [name, item] of Object.entries(value)) replies(item, into, name);
}

const fences = (text: string): string[] => text.match(/^```[\s\S]*?^```/gm) ?? [];

/** Prose with the protected regions taken out, as the pass reads it. */
const prose = (text: string): string =>
  text
    .replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, '')
    .split('\n')
    .filter((line) => !/^\s*(?:>|\||[—–―])|^ {4}/.test(line))
    .join('\n')
    .replace(/`+[^`\n]*`+/g, '')
    .replace(/\[[^\]\n]*\]\([^)\n]*\)/g, '')
    .replace(/(?:https?:\/\/|www\.|mailto:)\S+/g, '')
    .replace(/"[^"\n]*"|“[^”\n]*”/g, '');

describe.skipIf(!DIRECTORY)('the pass over a reply corpus', () => {
  test('streams the same, keeps code and leaves no English dash', () => {
    const corpus = new Set<string>();
    for (const file of files(DIRECTORY as string)) {
      try {
        replies(JSON.parse(readFileSync(file, 'utf8')), corpus);
      } catch {
        // Not JSON after all; nothing to read.
      }
    }
    let changed = 0;
    let dashes = 0;
    const left: number[] = [];
    let index = 0;
    for (const reply of corpus) {
      const whole = humanText(reply);
      if (whole !== reply) changed++;
      dashes += (prose(reply).match(/[—―]|\s–\s|\s--\s/g) ?? []).length;
      expect(whole.trim().length).toBeGreaterThan(0);
      expect(fences(whole)).toEqual(fences(reply));
      for (const size of [1, 3, 17]) {
        const pass = new HumanText();
        let shown = '';
        for (let at = 0; at < reply.length; at += size)
          shown += pass.push(reply.slice(at, at + size));
        shown += pass.end();
        expect(shown).toBe(whole);
      }
      const remaining = prose(whole)
        .split(/(?<=[.!?])\s+|\n/)
        .filter((sentence) => /[—―]|\s–\s|\s--\s/.test(sentence))
        .filter((sentence) => /\b(?:the|and|is|you|it|to|of)\b/i.test(sentence));
      if (remaining.length) {
        left.push(index);
        if (process.env.MELETE_REPLY_CORPUS_SHOW)
          process.stdout.write(`LEFT ${JSON.stringify(remaining)}\n`);
      }
      index++;
    }
    process.stdout.write(
      `replies ${corpus.size}, changed ${changed}, punctuation dashes in ${dashes}, replies with an English dash left ${left.length}\n`,
    );
    expect(corpus.size).toBeGreaterThan(0);
    expect(left).toEqual([]);
  }, 120_000);
});
