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

/**
 * The same length in letters and digits, which is what is counted: the pass
 * adds and removes punctuation, spaces and marks but never a letter, so a
 * second pass measures the reply the same way and decides the same.
 */
const SHORT_REPLY_LETTERS = SHORT_REPLY_CHARACTERS * 0.8;

const lettersIn = (text: string): number => text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;

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

/** Bold words that warn: their marks stay in a short reply, since the weight is the point. */
const WARNING =
  /\b(?:warning|caution|danger|dangerous|important|urgent|critical|never|do not|don't|must not|mustn't|stop)\b/i;

/** Openers that can be a yes on their own: before anything but service words, they stay. */
const YES = new Set(['certainly', 'absolutely', 'sure', 'sure thing', 'of course', 'no problem']);
/** How a reply goes on after a stock "Certainly!": the words of service, not an answer. */
const SERVICE_STARTS = [
  'here',
  "here's",
  "i'll",
  'i will',
  "i'd",
  'i would',
  'i can',
  "i've",
  "i'm happy",
  "i'm glad",
  'let me',
  "let's",
  'below',
  'the following',
  'happy to',
  'glad to',
];

/** Whether lowercase words still arriving could yet be an opener and its mark. */
function couldOpen(lower: string): boolean {
  const head = lower.slice(0, 48);
  return [...OPENER_STRONG, ...OPENER_WEAK].some((phrase) => {
    if (phrase.startsWith(head)) return true;
    if (!head.startsWith(phrase)) return false;
    return /^[ \t!.,]*$/.test(head.slice(phrase.length));
  });
}

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const OPENER = new RegExp(
  `^(?:(?:${OPENER_STRONG.map(literal).join('|')})[ \\t]*(?:[!.]+|,)|(?:${OPENER_WEAK.map(literal).join('|')})[ \\t]*!+)[ \\t]+(?=\\S)(?!#|>|\\||[-*+][ \\t]|\\d{1,3}[.)][ \\t])`,
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

/** What some words say about their language. */
type Signals = { nonLatin: boolean; english: boolean; other: boolean };

function signals(context: string): Signals {
  const text = straight(context);
  return {
    nonLatin: NON_LATIN.test(context),
    english: ENGLISH.test(text),
    // A letter outside plain Latin, or a small word of another language.
    // Symbols (a minus sign, a currency) say nothing about the language.
    other: /[^\p{ASCII}](?<=\p{L})/u.test(text) || FOREIGN.test(text),
  };
}

/**
 * Whether a sentence reads as English, so its dashes are English punctuation.
 * Every dash of a sentence is judged on the whole sentence, from its start to
 * its end, read once as the words go by. A dash that is changed changes no
 * letter, so a second pass reads the same sentence and decides the same way.
 */
class Language {
  private seen: Signals = { nonLatin: false, english: false, other: false };
  /** Words not yet read into `seen`; it is read up to a space, so no word is cut. */
  private tail = '';

  /** The sentence's verdict and where the sentence ends, once read: every dash in it shares it. */
  private verdict: { end: number; english: boolean } | null = null;

  reset(): void {
    this.seen = { nonLatin: false, english: false, other: false };
    this.tail = '';
    this.verdict = null;
  }

  /** The verdict for a dash whose words start at `at`, when the sentence was already read. */
  known(at: number): boolean | undefined {
    return this.verdict && at <= this.verdict.end ? this.verdict.english : undefined;
  }

  remember(end: number, english: boolean): void {
    this.verdict = { end, english };
  }

  add(text: string): void {
    this.tail += text;
    if (this.tail.length < 256) return;
    const cut = this.tail.search(/\s(?=\S*$)/);
    if (cut <= 0) return;
    this.fold(signals(this.tail.slice(0, cut)));
    this.tail = this.tail.slice(cut);
  }

  private fold(more: Signals): void {
    this.seen = {
      nonLatin: this.seen.nonLatin || more.nonLatin,
      english: this.seen.english || more.english,
      other: this.seen.other || more.other,
    };
  }

  /** With the rest of the sentence after the dash, `after`. */
  english(after: string): boolean {
    const all = [this.seen, signals(this.tail), signals(after)];
    if (all.some((s) => s.nonLatin)) return false;
    // A short fragment ("Status — done") counts when nothing in it is foreign.
    return all.some((s) => s.english) || !all.some((s) => s.other);
  }
}

/** Days and months, capitalised: "Mon – Fri" and "Jan – Mar" are ranges. */
const DAY_OR_MONTH =
  /^(?:Mon|Monday|Tue|Tues|Tuesday|Wed|Wednesday|Thu|Thur|Thurs|Thursday|Fri|Friday|Sat|Saturday|Sun|Sunday|Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|Sept|September|Oct|October|Nov|November|Dec|December)\.?$/;
/** A number that can end a range: "9", "$10", "20%", "9am", "4.5k". */
const RANGE_NUMBER = /^[$€£¥~]?\d[\d,.:]*(?:am|pm|%|k|m|bn|h|°[CF]?)?$/i;
/** An operand of a subtraction: one letter (not "a" or "I", which are words) or a number. */
const OPERAND = /^(?:[b-zB-HJ-Z]|\d[\d,.]*)$/;

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
  /** The line's heading marks were taken off, so a second pass reads it as plain. */
  private plainLine = false;
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
  /** How many characters have been read: where `pending` starts in the whole text. */
  private read = 0;
  /** The last characters read, for the rules that read the word before a dash. */
  private history = '\n';
  /** The language of the current sentence, as far as it has been read. */
  private language = new Language();
  /** A short reply's bold that carries a warning keeps its marks, and so does its close. */
  private boldKept = false;

  constructor(private readonly mode: HumanTextMode = 'reply') {
    this.markup = mode === 'reply' ? 'unknown' : 'keep';
  }

  push(piece: string): string {
    if (!piece) return '';
    this.pending += piece;
    this.seen += lettersIn(piece);
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
    this.read += count;
    this.previous = this.pending[count - 1] as string;
    this.history = (this.history + this.pending.slice(Math.max(0, count - 40), count)).slice(-40);
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
    this.language.add(shown);
    this.emit(shown);
  }

  private newLine(): void {
    this.lineStart = true;
    this.sentenceStart = true;
    this.afterTerminal = false;
    this.closeWith = null;
    this.boldOpen = false;
    this.boldKept = false;
    this.sentence = '';
    this.language.reset();
    this.sentenceAtLineStart = true;
    this.inUrl = false;
    this.verbatimLine = false;
    this.markedLine = false;
    this.plainLine = false;
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
    // One or two marks so far may still become a rule line.
    if (!known && /^([-*_])[ \t]*(?:\1[ \t]*)?$/.test(rest)) return WAIT;
    // Marks repeated ("# ## Plan") go together, so none is left for a second pass.
    const heading = /^(?:#{1,6}[ \t]+)+/.exec(rest);
    if (heading || (/^#{1,6}$/.test(rest) && !known)) {
      // The space after the mark is part of it, all of it, whatever the split.
      if (!heading || (!known && /^#{0,6}$/.test(rest.slice(heading[0].length)))) return WAIT;
      if (this.markupDecision(final) === WAIT) return WAIT;
      this.emit(this.markup === 'strip' ? indent : indent + heading[0]);
      this.consume(indent.length + heading[0].length);
      this.lineStart = false;
      this.markedLine = true;
      // A heading whose marks go reads as a plain line, to the closing lines too.
      this.plainLine = this.markup === 'strip';
      return true;
    }
    // A list mark, or a dash that opens the line (dialogue, or a list drawn with dashes).
    const mark = /^(?:[-*+]|\d{1,3}[.)]|[—–―])[ \t]+/.exec(rest);
    if (mark && mark[0].length === rest.length && !known) return WAIT;
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
    if (this.seen >= SHORT_REPLY_LETTERS) this.markup = 'keep';
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
      this.language.reset();
      this.sentenceAtLineStart = false;
      this.closeWith = null;
      this.afterTerminal = false;
    }
    if (this.sentenceStart && this.mode === 'reply') {
      if (this.messageStart) {
        const opened = this.opener(i, final);
        if (opened !== null) return opened;
      }
      if (!this.markedLine || this.plainLine) {
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
    if (c !== '-' && !DASH_CHARACTERS.has(c)) return null;
    if (c === '-' && !spaceBefore) return null;
    // One run of dashes is one mark, however it mixes them ("–--"), so none of
    // it is left for a second pass to find.
    while (p[end] === '-' || DASH_CHARACTERS.has(p[end] as string)) end++;
    if (end === p.length && !final) return WAIT;
    if (!/[—–―]/.test(p.slice(i, end))) {
      const length = end - i;
      if (length < 2 || length > 3) return null;
      if (p[end] !== undefined && !isSpace(p[end]) && p[end] !== '\n') return null;
    }
    let after = end;
    while (after < p.length && isSpace(p[after])) after++;
    const next = p[after];
    if (next === undefined && !final) return WAIT;
    let before = i;
    while (before > 0 && isSpace(p[before - 1])) before--;
    const spaceLeft = i - before + (before === 0 && i === 0 && isSpace(this.previous) ? 1 : 0);
    const spaceRight = after - end;
    const near = spaceLeft <= 1 && spaceRight <= 1 && next !== undefined && next !== '\n';
    let range =
      (near && isDigit(this.prevBefore(i)) && isDigit(next)) ||
      (c === EN_DASH && end - i === 1 && !spaceBefore && spaceRight === 0 && near);
    if (!range && near && /[\p{L}\p{N}$€£¥~]/u.test(next as string)) {
      // A range or a subtraction written with words on either side:
      // "9am – 5pm", "$10 – $20", "Mon – Fri", "x – y", "n – 1".
      const word = /^\S*/.exec(p.slice(after))?.[0] ?? '';
      if (after + word.length === p.length && !final) return WAIT;
      const right = word.replace(/[.,;:!?)\]"'”’]+$/, '');
      const left = (/\S+$/.exec((this.history + p.slice(0, i)).trimEnd())?.[0] ?? '').replace(
        /^[("'“‘[]+/,
        '',
      );
      // Numbers make a range only in the same currency: "due Oct 20 — $1,860" is two things.
      const currency = (word: string) => /^[$€£¥]?/.exec(word)?.[0];
      range =
        (RANGE_NUMBER.test(left) &&
          RANGE_NUMBER.test(right) &&
          currency(left) === currency(right)) ||
        (DAY_OR_MONTH.test(left) && DAY_OR_MONTH.test(right)) ||
        (OPERAND.test(left) && OPERAND.test(right) && /\p{L}/u.test(left + right));
    }
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
  private window(from: number, final: boolean, through = false): WindowEnd | Wait {
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
        if (!dash.range && !through) return { at: i, end: 'dash', crossed };
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
      if (!run.url && !through) {
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
    // The language is read on the whole sentence, past any dash or parenthesis,
    // once: the words before a later dash and after it are the same sentence.
    let english = this.language.known(this.read + found.after);
    if (english === undefined) {
      const sentenceEnd = ['sentence', 'line', 'final'].includes(window.end)
        ? window
        : this.window(found.after, final, true);
      if (sentenceEnd === WAIT) return WAIT;
      english = this.language.english(p.slice(found.after, sentenceEnd.at));
      // Past the window's cap the sentence is read as far as the cap, once.
      this.language.remember(this.read + sentenceEnd.at, english);
    }
    if (!english) {
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
        this.language.reset();
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
    if (this.boldKept) {
      this.boldKept = false;
      this.emitProse(`${ws}**`);
      this.consume(i + 2);
      return true;
    }
    const lineEnd = p.indexOf('\n', i);
    const line = p.slice(i + 2, lineEnd < 0 ? p.length : lineEnd);
    const close = line.indexOf('**');
    if (close > 0 && !isSpace(line[0]) && WARNING.test(straight(line.slice(0, close)))) {
      // A warning keeps its weight, even in a short reply.
      this.boldKept = true;
      this.emitProse(`${ws}**`);
      this.consume(i + 2);
      this.sentenceStart = false;
      return true;
    }
    if (close > 0 && !isSpace(line[0])) {
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
    // An opener goes only before words: "Sure! - a list" may yet be a list mark.
    if (match && !final && /^(?:[-*+]|\d{1,3}[.)]?)$/.test(p.slice(match[0].length))) return WAIT;
    const said = match?.[0]
      .toLowerCase()
      .replace(/[\s!.,]+/g, ' ')
      .trim();
    if (match && said && YES.has(said) && !match[0].includes(',')) {
      // "Absolutely." can be the answer itself ("Can I cancel? Absolutely. Fees
      // apply after Friday."): it goes only before the stock words of service.
      let rest = straight(p.slice(match[0].length)).toLowerCase();
      // Look past more openers: "Sure! Sure thing! I'll do it."
      for (let more = OPENER.exec(rest); more; more = OPENER.exec(rest))
        rest = rest.slice(more[0].length);
      const known = final || rest.includes('\n');
      if (!known && couldOpen(rest)) return WAIT;
      let goes = false;
      for (const start of SERVICE_STARTS) {
        if (rest.startsWith(start)) {
          const next = rest[start.length];
          if (next === undefined && !known) return WAIT;
          if (next === undefined || !isWordCharacter(next)) goes = true;
        } else if (start.startsWith(rest) && !known) return WAIT;
      }
      if (!goes) return null;
    }
    if (match) {
      // Dropped words do not count toward the reply's length.
      this.seen -= lettersIn(match[0]);
      this.consume(i + match[0].length);
      this.capitalizeNext = true;
      return true;
    }
    if (final || p.includes('\n')) return null;
    // Still arriving: wait while the words so far could be an opener and its mark.
    return couldOpen(straight(p).toLowerCase()) ? WAIT : null;
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
