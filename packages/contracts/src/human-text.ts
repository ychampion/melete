/**
 * Text that reads like a person wrote it.
 *
 * The identity file asks the model for plain replies, but a request is a wish.
 * This pass makes a few of those wishes true without a model, on the agent
 * text a person reads: the reply as it streams, the saved answer, and the body
 * of a draft or message the agent writes for someone else.
 *
 * What it changes:
 *
 * - A dash used as punctuation (an em dash, a spaced en dash, or a spaced
 *   double hyphen) becomes what a person would type: a comma, a colon, a
 *   period, or a pair of commas or parentheses around an aside. A dash in a
 *   range or a compound ("9–5", "Mon–Fri", "New York–London") becomes a hyphen.
 * - In a reply (not a draft): a stock opener ("Certainly!", "Great
 *   question!") before the real first words, and stock closing lines ("I hope
 *   this helps!", "Let me know if you have any other questions.") at the very
 *   end, are dropped; in a short reply, bold and heading marks are taken off
 *   and their words kept.
 *
 * What it never touches: fenced or indented code, inline code, links and
 * addresses, quoted text, block quotes, tables, a dash that opens a line (a
 * list mark or dialogue), and a sentence that does not read as English, since
 * other languages need their dashes. When a rule is unsure, the text is left
 * as it came.
 *
 * It is stream-safe by construction. `HumanText` reads text in pieces of any
 * size and returns what can be shown so far. Each decision waits only until
 * the words it depends on have arrived, and reads nothing past them, so the
 * same text gives the same output however it was split. `humanText` is one
 * push of the whole text.
 */

/** A reply is the agent talking to the person; a draft is written for someone else. */
export type HumanTextMode = 'reply' | 'draft';

/** A reply this long or longer keeps its bold and headings; a shorter one reads as prose. */
export const SHORT_REPLY_CHARACTERS = 600;

/** How far a dash looks ahead for the end of its aside before it decides alone. */
const DASH_WINDOW = 600;

/** Past this, the start of a sentence cannot be a stock closing line. */
const CLOSER_MAX_CHARACTERS = 160;

const DASH_CHARACTERS = new Set(['—', '–', '―']);
const EN_DASH = '–';

const isSpace = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\r' || c === ' ';
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isWordCharacter = (c: string | undefined): boolean =>
  c !== undefined && /[\p{L}\p{N}]/u.test(c);

const URL_STARTS = ['https://', 'http://', 'www.', 'mailto:'];

/** A run of words that ends a sentence: "done.", "done.)", "done?\"". */
const TERMINAL = /[.!?…]["'”’)\]*_]*$/;

/** Scripts whose own punctuation uses dashes the English rules would break. */
const NON_LATIN = /[Ͱ-ϿЀ-ԯ֐-׿؀-ۿऀ-෿฀-๿ᄀ-ᇿ　-ヿ㐀-鿿가-힯＀-￯]/u;

/** Words common in English and rare as whole words in the languages that keep their dashes. */
const ENGLISH =
  /\b(?:the|and|but|of|for|with|is|are|it|you|we|they|this|that|not|your|my|have|has|can|from|our|their|just|what|which|been|would|should|could|there|here|it's|that's|i'm|i'll|don't)\b/i;

/** Small words of the languages that keep a dash as punctuation of their own. */
const FOREIGN =
  /(?:^|[^\p{L}])(?:jest|nie|się|że|est|c'est|les|une|des|und|ist|der|die|das|nicht|que|los|las|del|una|il|che|non|é|não|os|är|och|ikke|og|het|een)(?=$|[^\p{L}])/iu;

/** The words before a dash that announce what follows it: "The fix — restart it." */
const CUE =
  /(?:\b(?:following|these|this|here's|here is|as follows)|\bthe (?:answer|catch|problem|issue|result|reason|rule|point|trick|fix|plan|verdict|upshot|short version|bottom line|good news|bad news|key|gist|takeaway|difference|choice|options?)|\b(?:one|two|three|four|five|a few|several) (?:things?|options?|reasons?|steps?|ways?|ideas?|choices?))\s*$/i;

/** Words that open a clause of its own: after a dash, they start a new sentence. */
const PRONOUN =
  /^(?:i|i'm|i've|i'll|i'd|you|you're|you'll|you've|we|we're|we'll|we've|they|they're|they'll|he|she|he's|she's|it|it's|that's|there's|there are|there is|this is|here's|here are|everything|nothing|both)\b/i;

/** A subject that needs a verb after it before the words are a clause: "the bump is on record". */
const SUBJECT =
  /^(?:the|a|an|my|your|our|his|her|their|its|this|that|these|those|one|two|three|four|five|six|seven|eight|nine|ten|\d[\d,.]*|every|each|all|most|some|no|nobody|everyone|someone|none|neither|either|[a-z]+ing)\b/i;

const VERB =
  /\b(?:is|are|was|were|has|have|had|will|would|can|could|should|does|did|do|isn't|aren't|wasn't|weren't|won't|can't|doesn't|don't|didn't|stays?|goes|runs|works|looks|lands|comes|needs|counts|shows|says|means|flips|holds|covers|takes|makes|gets|starts|ends|fails|matches|reads|sits|leaves|arrives|lives|belongs)\b/i;

/** An instruction to the person: after a dash, it is a sentence of its own. */
const IMPERATIVE =
  /^(?:let me|let's|note|remember|keep|check|make sure|don't|do not|try|ask|tell|see|use|skip|call|send|take|bring|book|pick|wait|stop|pay|move|open|read|reply|verify|confirm|rotate|renew|cancel|save|treat|watch|expect|want me to|should i|shall i|do you want)\b/i;

/** Words that continue the sentence: after a dash, a comma reads naturally. */
const CONTINUES =
  /^(?:but|and|so|or|yet|nor|because|though|although|while|which|who|whose|plus|especially|including|like|not|than|as|rather than|instead of)\b/i;

/** A word or two that opens a reply and introduces what follows: "Noted — step-free only." */
const ACKNOWLEDGED =
  /^(?:noted|got it|done|set|ok|okay|yes|no|sure|right|understood|booked|sent|saved|fixed|added|moved|confirmed|update|heads up|good news|bad news|short answer|bottom line|in short)$/i;

const wordsIn = (text: string): number => text.split(/\s+/).filter(Boolean).length;
/** A stock opener that may go when the reply goes on after it, with its punctuation. */
const OPENER_STRONG = [
  'certainly',
  'absolutely',
  'great question',
  'good question',
  'excellent question',
  'what a great question',
  "i'd be happy to help",
  'i would be happy to help',
  'happy to help',
];
/** Openers that are ordinary words with a comma, and so go only before an exclamation mark. */
const OPENER_WEAK = ['sure', 'sure thing', 'great', 'perfect', 'of course', 'no problem'];

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const OPENER = new RegExp(
  `^(?:(?:${OPENER_STRONG.map(literal).join('|')})[ \\t]*(?:[!.]+|,)|(?:${OPENER_WEAK.map(literal).join('|')})[ \\t]*!+)[ \\t]+(?=\\S)`,
  'i',
);

/** How a stock closing line starts; a sentence that cannot start this way is never held. */
const CLOSER_STARTS = [
  'i hope this',
  'i hope that',
  'i hope it',
  'i hope you find',
  'hope this',
  'hope that',
  'hope it',
  'hope you find',
  'please let me know if',
  'please feel free',
  "please don't",
  'please do not',
  'let me know if',
  'feel free to',
  "don't hesitate",
  'do not hesitate',
  'is there anything else',
  'anything else i can',
  'anything else you',
  "i'm happy to help",
  "i'm always happy to help",
  'happy to help',
  'always happy to help',
  'glad i could help',
  'glad to help',
];

/** The whole of a stock closing line. Anything specific in it keeps it. */
const CLOSERS: readonly RegExp[] = [
  /^(?:i )?hope (?:this|that|it) (?:helps|was helpful|is helpful)(?: you)?(?: out)?(?: a bit| a lot| some)?(?:,? (?:and )?(?:good luck|cheers))?[!.]*$/i,
  /^(?:i )?hope you find (?:this|that|it) (?:helpful|useful)[!.]*$/i,
  /^(?:please )?(?:let me know|feel free to (?:let me know|ask|reach out)|don't hesitate to (?:ask|reach out|let me know)|do not hesitate to (?:ask|reach out|let me know))(?: if| whether)? (?:you have|there are|you've got) any (?:other |more |further |follow-up |additional )?questions[^.!?\n]{0,40}[.!]*$/i,
  /^(?:please )?let me know if (?:you need|there's|there is|you'd like|you want) anything else[^.!?\n]{0,40}[.!]*$/i,
  /^(?:please )?(?:feel free to|don't hesitate to|do not hesitate to) (?:ask|reach out|let me know)[^.!?\n]{0,40}[.!]*$/i,
  /^(?:is there )?anything else (?:i can (?:help(?: you)? with|do(?: for you)?)|you(?:'d like| would like| want)(?: me)? to (?:do|help with|know))[^.!?\n]{0,20}\?$/i,
  /^(?:i'm )?(?:always )?happy to help(?: further| more| anytime| any time)?[!.]*$/i,
  /^glad (?:i could|to) help[!.]*$/i,
];

/** Curly apostrophes read the same as straight ones to every rule here. */
const straight = (text: string): string => text.replace(/[‘’]/g, "'");

/** Whether a sentence reads as English, so its dashes are English punctuation. */
function readsAsEnglish(context: string): boolean {
  if (NON_LATIN.test(context)) return false;
  const text = straight(context);
  if (ENGLISH.test(text)) return true;
  // A short fragment ("Status — done"), with no letter outside plain Latin and
  // no small word of another language in it. Symbols (a minus sign, a currency)
  // say nothing about the language.
  return !/[^\p{ASCII}](?<=\p{L})/u.test(text) && !FOREIGN.test(text);
}

const WAIT = Symbol('wait');
type Wait = typeof WAIT;
type Step = Wait | true;

/** A dash found at a position: how long it is, what comes after it, and what it is. */
type Dash = {
  length: number;
  /** The index just past the whitespace that follows the dash. */
  after: number;
  spaceAfter: string;
  next: string | undefined;
  range: boolean;
};

type WindowEnd = {
  at: number;
  end: 'dash' | 'sentence' | 'clause' | 'line' | 'final' | 'cap';
  /** The words passed bold marks or parentheses, so they cannot be one aside. */
  crossed: boolean;
};

/**
 * The pass, one piece at a time. `push` takes the next piece of text and
 * returns what can be shown so far; `end` returns the rest once the text is
 * complete. One instance is one message: a new message starts a new one.
 */
export class HumanText {
  private pending = '';
  private seen = 0;
  private out = '';
  /** Whitespace not yet shown: it goes out with the next words, or with the end. */
  private trail = '';
  /** A stock closing line, shown only if more words follow it. */
  private held = '';
  /** Whether any words have been shown: a reply is never left empty. */
  private spoke = false;
  private lineStart = true;
  private fence: string | null = null;
  private verbatimLine = false;
  /** The line opened with a list mark or a heading: its sentence is not a closing line. */
  private markedLine = false;
  private messageStart = true;
  private sentenceStart = true;
  private afterTerminal = false;
  private capitalizeNext = false;
  private inUrl = false;
  /** What the dash closing an aside becomes: a comma or a closing parenthesis. */
  private closeWith: ',' | ')' | null = null;
  private markup: 'unknown' | 'keep' | 'strip';
  private boldOpen = false;
  /** The current sentence as shown so far, for the rules that read what came before a dash. */
  private sentence = '';
  /** The current sentence began its line, so a short one before a dash is a label. */
  private sentenceAtLineStart = true;
  /** The last character read, for the rules that read what came just before. */
  private previous = '\n';

  constructor(private readonly mode: HumanTextMode = 'reply') {
    this.markup = mode === 'reply' ? 'unknown' : 'keep';
  }

  push(piece: string): string {
    if (!piece) return '';
    this.pending += piece;
    this.seen += piece.length;
    return this.run(false);
  }

  end(): string {
    let shown = this.run(true);
    // Whitespace that ended the text stays; a closing line held at the end goes,
    // unless it is all the reply says.
    if (!this.held) shown += this.trail;
    else if (!this.spoke) shown += this.held.trimStart();
    this.trail = '';
    this.held = '';
    return shown;
  }

  private run(final: boolean): string {
    this.out = '';
    while (this.pending.length > 0) {
      const step = this.lineStart ? this.startLine(final) : this.step(final);
      if (step === WAIT) break;
    }
    return this.out;
  }

  private consume(count: number): void {
    if (count <= 0) return;
    this.previous = this.pending[count - 1] as string;
    this.pending = this.pending.slice(count);
  }

  /** Text to show. Whitespace waits for the words after it. */
  private emit(text: string): void {
    if (!text) return;
    if (/^\s*$/.test(text)) {
      if (this.held) this.held += text;
      else this.trail += text;
      return;
    }
    if (this.held) {
      this.out += this.held;
      this.held = '';
    }
    this.out += this.trail + text;
    this.trail = '';
    this.messageStart = false;
    this.spoke = true;
  }

  /** Nothing is waiting: the text so far has all been shown. */
  get idle(): boolean {
    return !this.pending && !this.trail && !this.held;
  }

  /** Prose to show, with the sentence it belongs to kept for later rules. */
  private emitProse(text: string): void {
    let shown = text;
    if (this.capitalizeNext && /\S/.test(shown)) {
      shown = shown.replace(
        /^(\s*)(\p{Ll})/u,
        (_, space: string, letter: string) => space + letter.toUpperCase(),
      );
      this.capitalizeNext = false;
    }
    this.sentence = (this.sentence + shown).slice(-300);
    this.emit(shown);
  }

  private newLine(): void {
    this.lineStart = true;
    this.sentenceStart = true;
    this.afterTerminal = false;
    this.closeWith = null;
    this.boldOpen = false;
    this.sentence = '';
    this.sentenceAtLineStart = true;
    this.inUrl = false;
    this.verbatimLine = false;
    this.markedLine = false;
  }

  /** The rest of this line, as it came. */
  private verbatim(): Step {
    const p = this.pending;
    const newline = p.indexOf('\n');
    if (newline < 0) {
      this.emit(p);
      this.consume(p.length);
      return true;
    }
    this.emit(p.slice(0, newline));
    this.emit('\n');
    this.consume(newline + 1);
    this.newLine();
    return true;
  }

  /** Decide what kind of line this is from its first characters. */
  private startLine(final: boolean): Step {
    const p = this.pending;
    if (this.verbatimLine) return this.verbatim();
    const indent = /^[ \t]*/.exec(p)?.[0] ?? '';
    const rest = p.slice(indent.length);
    const known = rest.includes('\n') || final;
    if (!rest.length && !final) return WAIT;
    if (rest.startsWith('\n')) {
      this.emit(`${indent}\n`);
      this.consume(indent.length + 1);
      this.newLine();
      return true;
    }
    if (this.fence) {
      if (rest.length < this.fence.length && !known) return WAIT;
      if (rest.startsWith(this.fence)) this.fence = null;
      this.verbatimLine = true;
      return this.verbatim();
    }
    // Indented code, a block quote and a table are someone else's words or layout.
    if (indent.replace(/\t/g, '    ').length >= 4 || rest.startsWith('>') || rest.startsWith('|')) {
      this.verbatimLine = true;
      return this.verbatim();
    }
    if (rest.length < 3 && !known) return WAIT;
    const fence = /^(`{3,}|~{3,})/.exec(rest);
    if (fence) {
      this.fence = (fence[1] as string).slice(0, 3);
      this.verbatimLine = true;
      return this.verbatim();
    }
    // A rule line (--- *** ___) is layout.
    if (/^([-*_])[ \t]*\1[ \t]*\1/.test(rest)) {
      const line = rest.split('\n', 1)[0] as string;
      if (!known) return WAIT;
      if (/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) {
        this.verbatimLine = true;
        return this.verbatim();
      }
    }
    const heading = /^#{1,6}[ \t]+/.exec(rest);
    if (heading || (/^#{1,6}$/.test(rest) && !known)) {
      if (!heading) return WAIT;
      if (this.markupDecision(final) === WAIT) return WAIT;
      this.emit(this.markup === 'strip' ? indent : indent + heading[0]);
      this.consume(indent.length + heading[0].length);
      this.lineStart = false;
      this.markedLine = true;
      return true;
    }
    // A list mark, or a dash that opens the line (dialogue, or a list drawn with dashes).
    const mark = /^(?:[-*+]|\d{1,3}[.)]|[—–―])[ \t]+/.exec(rest);
    if (mark) {
      this.emit(indent + mark[0]);
      this.consume(indent.length + mark[0].length);
      this.lineStart = false;
      this.markedLine = true;
      return true;
    }
    if (!known && /^(?:[-*+]|\d{1,3}[.)]?|[—–―]+)$/.test(rest)) return WAIT;
    const bare = /^[—–―]+/.exec(rest);
    if (bare) {
      this.emit(indent + bare[0]);
      this.consume(indent.length + bare[0].length);
      this.lineStart = false;
      this.markedLine = true;
      return true;
    }
    this.lineStart = false;
    return true;
  }

  /** Bold and headings stay in a long reply and go from a short one, decided once. */
  private markupDecision(final: boolean): Step {
    if (this.markup !== 'unknown') return true;
    if (this.seen >= SHORT_REPLY_CHARACTERS) this.markup = 'keep';
    else if (final) this.markup = 'strip';
    else return WAIT;
    return true;
  }

  /** One piece of prose: whitespace and what follows it. */
  private step(final: boolean): Step {
    if (this.verbatimLine) return this.verbatim();
    const p = this.pending;
    let i = 0;
    while (i < p.length && isSpace(p[i])) i++;
    const ws = p.slice(0, i);
    if (i === p.length) {
      if (!final) return WAIT;
      this.emit(ws);
      this.consume(i);
      return true;
    }
    const c = p[i] as string;
    if (c === '\n') {
      this.emit(ws);
      this.emit('\n');
      this.consume(i + 1);
      this.newLine();
      return true;
    }
    if (this.inUrl && i === 0) return this.word(ws, i, final);
    this.inUrl = false;
    if (ws && this.afterTerminal) {
      this.sentenceStart = true;
      this.sentence = '';
      this.sentenceAtLineStart = false;
      this.closeWith = null;
      this.afterTerminal = false;
    }
    if (this.sentenceStart && this.mode === 'reply') {
      if (this.messageStart) {
        const opened = this.opener(i, final);
        if (opened !== null) return opened;
      }
      if (!this.markedLine) {
        const closed = this.closer(ws, i, final);
        if (closed !== null) return closed;
      }
    }
    const dash = this.dashAt(i, final);
    if (dash === WAIT) return WAIT;
    if (dash) return this.dash(ws, i, dash, final);
    if (c === '`' || c === '"' || c === '“') return this.protectedSpan(ws, i, final);
    if (c === '*') {
      if (p[i + 1] === undefined && !final) return WAIT;
      if (p[i + 1] === '*') return this.bold(ws, i, final);
    }
    return this.word(ws, i, final);
  }

  /** The character before the whitespace that precedes `i`. */
  private prevBefore(i: number): string | undefined {
    let j = i - 1;
    while (j >= 0 && isSpace(this.pending[j])) j--;
    return j >= 0 ? this.pending[j] : this.previous;
  }

  /**
   * A dash used as punctuation, or as a range, at `i`: null when there is
   * none, WAIT while the characters that decide it are still arriving. The
   * sequential reader and the look-ahead window both ask this, so they agree.
   */
  private dashAt(i: number, final: boolean): Dash | null | Wait {
    const p = this.pending;
    const c = p[i] as string;
    let end = i + 1;
    const spaceBefore = i === 0 ? isSpace(this.previous) : isSpace(p[i - 1]);
    if (c === '-') {
      if (!spaceBefore) return null;
      while (p[end] === '-') end++;
      if (end === p.length && !final) return WAIT;
      const length = end - i;
      if (length < 2 || length > 3) return null;
      if (p[end] !== undefined && !isSpace(p[end]) && p[end] !== '\n') return null;
    } else if (DASH_CHARACTERS.has(c)) {
      while (p[end] === c) end++;
      if (end === p.length && !final) return WAIT;
    } else {
      return null;
    }
    let after = end;
    while (after < p.length && isSpace(p[after])) after++;
    const next = p[after];
    if (next === undefined && !final) return WAIT;
    let before = i;
    while (before > 0 && isSpace(p[before - 1])) before--;
    const spaceLeft = i - before + (before === 0 && i === 0 && isSpace(this.previous) ? 1 : 0);
    const spaceRight = after - end;
    const range =
      (isDigit(this.prevBefore(i)) && isDigit(next) && spaceLeft <= 1 && spaceRight <= 1) ||
      (c === EN_DASH &&
        end - i === 1 &&
        !spaceBefore &&
        spaceRight === 0 &&
        next !== undefined &&
        next !== '\n');
    return { length: end - i, after, spaceAfter: p.slice(end, after), next, range };
  }

  /**
   * One run of characters from `i`: up to whitespace, or to a mark that the
   * reader handles on its own. Links run to their whitespace whole.
   */
  private runEnd(
    i: number,
    final: boolean,
    continuing: boolean,
  ): { end: number; url: boolean } | Wait {
    const p = this.pending;
    let j = i;
    let url = continuing;
    while (j < p.length) {
      const ch = p[j] as string;
      if (isSpace(ch) || ch === '\n') break;
      if (!url && this.urlStartsAt(j)) url = true;
      if (!url && j > i) {
        if (DASH_CHARACTERS.has(ch) || ch === '`' || ch === '"' || ch === '“') break;
        if (ch === '*' && p[j + 1] === undefined && !final) break;
        if (ch === '*' && p[j + 1] === '*') break;
      }
      if (!url && ch === ']' && p[j + 1] === '(') {
        // A link's address is part of the link.
        const close = p.indexOf(')', j + 2);
        const lineEnd = p.indexOf('\n', j);
        if (close >= 0 && (lineEnd < 0 || close < lineEnd)) {
          j = close + 1;
          continue;
        }
        if (lineEnd < 0 && !final) return j === i ? WAIT : { end: j, url };
      }
      if (!url && ch === ']' && p[j + 1] === undefined && !final) break;
      j++;
    }
    return { end: j, url };
  }

  private urlStartsAt(i: number): boolean {
    const before = i === 0 ? this.previous : this.pending[i - 1];
    if (isWordCharacter(before)) return false;
    const head = this.pending.slice(i, i + 8).toLowerCase();
    return URL_STARTS.some((start) => head.startsWith(start));
  }

  /**
   * Where inline code or a quote that opens at `i` closes on its line, just
   * past its closing mark; null when it never closes there (the mark is then
   * an ordinary character), or WAIT while the line is still arriving.
   */
  private closingOf(i: number, final: boolean): number | null | Wait {
    const p = this.pending;
    const c = p[i] as string;
    let open = 1;
    if (c === '`') while (p[i + open] === '`') open++;
    if (c === '`' && i + open === p.length && !final) return WAIT;
    const mark = c === '`' ? '`'.repeat(open) : c === '“' ? '”' : '"';
    const lineEnd = p.indexOf('\n', i);
    const limit = lineEnd < 0 ? p.length : lineEnd;
    let at = p.indexOf(mark, i + open);
    while (at >= 0 && at < limit) {
      if (c !== '`' || (p[at - 1] !== '`' && p[at + open] !== '`')) {
        if (c === '`' && at + open === p.length && !final) return WAIT;
        return at + mark.length;
      }
      at = p.indexOf(mark, at + 1);
    }
    if (lineEnd < 0 && !final) return WAIT;
    return null;
  }

  private openLength(i: number): number {
    let open = 1;
    if (this.pending[i] === '`') while (this.pending[i + open] === '`') open++;
    return open;
  }

  /**
   * From `from`, where the words after a dash end: at the next dash used as
   * punctuation, at the end of the sentence or line, or after `DASH_WINDOW`
   * characters. It reads the text the way the reader does, piece by piece, so
   * it finds the same ends.
   */
  private window(from: number, final: boolean): WindowEnd | Wait {
    const p = this.pending;
    let i = from;
    let terminal = false;
    let crossed = false;
    let depth = 0;
    while (true) {
      if (i - from > DASH_WINDOW) return { at: i, end: 'cap', crossed };
      const space = i;
      while (i < p.length && isSpace(p[i])) i++;
      if (i >= p.length) {
        if (!final) return WAIT;
        return { at: space, end: terminal ? 'sentence' : 'final', crossed };
      }
      const c = p[i] as string;
      if (c === '\n') return { at: space, end: terminal ? 'sentence' : 'line', crossed };
      if (i > space && terminal) return { at: space, end: 'sentence', crossed };
      const dash = this.dashAt(i, final);
      if (dash === WAIT) return WAIT;
      if (dash) {
        if (!dash.range) return { at: i, end: 'dash', crossed };
        terminal = false;
        i = dash.after;
        continue;
      }
      if (c === '`' || c === '"' || c === '\u201c') {
        const close = this.closingOf(i, final);
        if (close === WAIT) return WAIT;
        if (close === null) {
          i += this.openLength(i);
          terminal = false;
        } else {
          terminal = /[.!?\u2026]["\u201d]$/.test(p.slice(i, close));
          i = close;
        }
        continue;
      }
      if (c === '*') {
        if (p[i + 1] === undefined && !final) return WAIT;
        if (p[i + 1] === '*') {
          // An aside does not reach across the edge of bold text.
          crossed = true;
          i += 2;
          continue;
        }
      }
      const run = this.runEnd(i, final, false);
      if (run === WAIT) return WAIT;
      if (run.end <= i) {
        if (!final) return WAIT;
        i++;
        continue;
      }
      if (run.end === p.length && !final) return WAIT;
      const text = p.slice(i, run.end);
      if (!run.url) {
        // Parentheses: one closing a parenthesis opened before the dash ends its words.
        const plain = text.replace(/\]\([^)]*\)/g, ']');
        for (let k = 0; k < plain.length; k++) {
          if (plain[k] === '(') {
            depth++;
            crossed = true;
          } else if (plain[k] === ')') {
            if (depth === 0) return { at: i + text.indexOf(')'), end: 'clause', crossed };
            depth--;
            crossed = true;
          }
        }
      }
      terminal = TERMINAL.test(text);
      i = run.end;
    }
  }
  private dash(ws: string, i: number, found: Dash, final: boolean): Step {
    const p = this.pending;
    const token = p.slice(i, i + found.length);
    const next = found.next;
    const consumeAll = () => this.consume(found.after);

    // A range or a compound: 9–5, 9:00–17:00, Mon–Fri, $10–$20.
    if (found.range) {
      this.emitProse('-');
      consumeAll();
      return true;
    }

    if (this.closeWith) {
      const close = this.closeWith;
      this.closeWith = null;
      const ends = next === undefined || next === '\n' || /[,.;:!?)]/.test(next);
      if (close === ')') this.emitProse(ends ? ')' : ') ');
      else if (!ends) this.emitProse(', ');
      consumeAll();
      return true;
    }

    const window = this.window(found.after, final);
    if (window === WAIT) return WAIT;
    const after = p.slice(found.after, window.at);
    if (!readsAsEnglish(`${this.sentence} ${after}`)) {
      // Not English, or not sure: another language may need its dash.
      this.emitProse(ws + token + found.spaceAfter);
      consumeAll();
      return true;
    }
    const core = after.replace(/[\s.!?\u2026]+$/, '');
    const last = this.sentence.trimEnd().slice(-1);
    if (!this.sentence.trim()) {
      // A dash where the sentence begins carries nothing but its space.
      this.emitProse(ws ? ' ' : '');
    } else if (!core.trim()) {
      // "and then—." ends on the sentence's own mark; a dash ending a line
      // introduces it, and one ending the text trails off.
      if (window.end === 'final') this.emitProse('...');
      else if (window.end === 'line') this.emitProse(':');
    } else if (/[,;:(]/.test(last)) {
      this.emitProse(last === '(' ? '' : ' ');
    } else if (window.end === 'dash' && !window.crossed) {
      const parens = /[,;:]/.test(after) || after.length > 90;
      this.closeWith = parens ? ')' : ',';
      this.emitProse(parens ? ' (' : ', ');
    } else {
      const mark = this.single(after);
      this.emitProse(mark === '.' ? '.' : `${mark} `);
      if (mark === '.') {
        this.emitProse(' ');
        this.capitalizeNext = true;
        this.sentence = '';
        this.sentenceAtLineStart = false;
      }
    }
    consumeAll();
    return true;
  }

  /**
   * What one dash becomes when nothing closes it, from the words on either
   * side: a comma when the sentence carries on, a period before a clause or an
   * instruction of its own, a colon after a label or before what was announced.
   */
  private single(after: string): ',' | ':' | '.' {
    const words = straight(after.trim());
    const before = straight(this.sentence.replace(/\*\*/g, '').trim());
    const colonFree = !before.includes(':') && !words.includes(':');
    const label =
      this.sentenceAtLineStart &&
      (this.markedLine ? wordsIn(before) <= 4 : ACKNOWLEDGED.test(before));
    if (CONTINUES.test(words)) return ',';
    if (label && this.markedLine && colonFree) return ':';
    if (PRONOUN.test(words) && wordsIn(words) >= 3) return '.';
    if (SUBJECT.test(words) && VERB.test(words) && wordsIn(words) >= 4) return '.';
    if (IMPERATIVE.test(words) && wordsIn(words) >= 2) return '.';
    if (/^(?:if|when|once|unless)\b/i.test(words) && words.includes(',')) return '.';
    if (colonFree) {
      const parts = words.split(/,\s*|\s+(?:and|or)\s+/).filter(Boolean);
      const listed = parts.length >= 3 && parts.slice(0, 2).every((part) => wordsIn(part) <= 4);
      if (label || CUE.test(before) || listed) return ':';
    }
    return ',';
  }

  /** Inline code or a quote, shown exactly as it came. */
  private protectedSpan(ws: string, i: number, final: boolean): Step {
    const close = this.closingOf(i, final);
    if (close === WAIT) return WAIT;
    const p = this.pending;
    this.sentenceStart = false;
    if (close === null) {
      const open = this.openLength(i);
      this.emitProse(ws + p.slice(i, i + open));
      this.consume(i + open);
      this.afterTerminal = false;
      return true;
    }
    const span = p.slice(i, close);
    // The span's first letter is someone else's, so it is never capitalised.
    this.capitalizeNext = false;
    this.emitProse(ws + span);
    this.consume(close);
    this.afterTerminal = /[.!?…]["”]$/.test(span);
    return true;
  }

  private bold(ws: string, i: number, final: boolean): Step {
    if (this.markupDecision(final) === WAIT) return WAIT;
    const p = this.pending;
    if (this.markup === 'keep') {
      this.emitProse(`${ws}**`);
      this.consume(i + 2);
      this.sentenceStart = false;
      return true;
    }
    if (this.boldOpen) {
      this.boldOpen = false;
      this.emitProse(ws);
      this.consume(i + 2);
      return true;
    }
    const lineEnd = p.indexOf('\n', i);
    const line = p.slice(i + 2, lineEnd < 0 ? p.length : lineEnd);
    if (line.indexOf('**') > 0 && !isSpace(line[0])) {
      this.boldOpen = true;
      this.emitProse(ws);
      this.consume(i + 2);
      return true;
    }
    this.emitProse(`${ws}**`);
    this.consume(i + 2);
    this.sentenceStart = false;
    return true;
  }

  /** A stock opener before the reply's first real words goes; the next word is capitalised. */
  private opener(i: number, final: boolean): Step | null {
    const p = this.pending.slice(i);
    const match = OPENER.exec(straight(p));
    if (match) {
      this.consume(i + match[0].length);
      this.capitalizeNext = true;
      return true;
    }
    if (final || p.includes('\n')) return null;
    // Still arriving: wait while the words so far could be an opener and its mark.
    const lower = straight(p.slice(0, 48)).toLowerCase();
    const could = [...OPENER_STRONG, ...OPENER_WEAK].some((phrase) => {
      if (phrase.startsWith(lower)) return true;
      if (!lower.startsWith(phrase)) return false;
      return /^[ \t!.,]*$/.test(lower.slice(phrase.length));
    });
    return could ? WAIT : null;
  }

  /**
   * A stock closing line is held until more words follow it; at the end of the
   * reply it goes. Only a whole sentence of prose that matches one is held.
   */
  private closer(ws: string, i: number, final: boolean): Step | null {
    const rest = this.pending.slice(i);
    const lower = straight(rest.slice(0, CLOSER_MAX_CHARACTERS)).toLowerCase();
    if (!CLOSER_STARTS.some((start) => start.startsWith(lower) || lower.startsWith(start)))
      return null;
    if (!CLOSER_STARTS.some((start) => lower.startsWith(start))) return final ? null : WAIT;
    const end = /[.!?…]+(?=[ \t\r \n]|$)/.exec(rest);
    const newline = rest.indexOf('\n');
    let stop: number;
    if (end && (newline < 0 || end.index < newline)) {
      stop = end.index + end[0].length;
      if (stop === rest.length && !final) return WAIT;
    } else if (newline >= 0) {
      stop = newline;
    } else if (final) {
      stop = rest.length;
    } else {
      return rest.length > CLOSER_MAX_CHARACTERS ? null : WAIT;
    }
    if (stop > CLOSER_MAX_CHARACTERS) return null;
    const sentence = straight(rest.slice(0, stop)).replace(/\s+/g, ' ').trim();
    if (!CLOSERS.some((closer) => closer.test(sentence))) return null;
    this.held += this.trail + ws + rest.slice(0, stop);
    this.trail = '';
    this.consume(i + stop);
    this.afterTerminal = true;
    this.sentenceStart = false;
    return true;
  }

  /** An ordinary run of characters, up to the next whitespace or mark. */
  private word(ws: string, i: number, final: boolean): Step {
    const p = this.pending;
    const continuing = this.inUrl && i === 0;
    const run = this.runEnd(i, final, continuing);
    if (run === WAIT) return WAIT;
    const j = run.end;
    let cut = j;
    if (j === p.length && !final && !run.url) {
      // Hold a tail that may yet become a link.
      for (let k = Math.max(i, j - 8); k < j; k++) {
        const before = k === 0 ? this.previous : p[k - 1];
        if (isWordCharacter(before)) continue;
        const tail = p.slice(k, j).toLowerCase();
        if (URL_STARTS.some((start) => start.startsWith(tail))) {
          cut = k;
          break;
        }
      }
    }
    if (cut === i) return WAIT;
    const text = p.slice(i, cut);
    if (run.url) this.capitalizeNext = false;
    this.emitProse(ws + text);
    this.consume(cut);
    this.inUrl = run.url && cut === p.length;
    this.sentenceStart = false;
    this.afterTerminal = TERMINAL.test(text);
    return true;
  }
}

/** The pass over a whole text at once. */
export function humanText(text: string, mode: HumanTextMode = 'reply'): string {
  const pass = new HumanText(mode);
  return pass.push(text) + pass.end();
}
