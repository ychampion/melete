/**
 * A deterministic stand-in for a model that follows instructions literally.
 *
 * It reads the bodies it was delivered, and the owner's messages, as steps in a
 * small closed grammar. Every recognised step is a whole line or a whole clause,
 * identified by its leading verb and its complete shape; nothing is recognised
 * because a distinctive phrase happens to appear somewhere in a body. Steps are
 * applied in the order they arrive, so a reordered or missing step produces a
 * different answer, and an arm that was delivered no body produces the default
 * draft. A reviewer can read this file and see that whatever a candidate arm does
 * follows from the steps it was given.
 */

export type StepForm =
  | { form: 'word_limit'; max: number }
  | { form: 'list'; style: 'bullets' | 'numbered' }
  | { form: 'opening'; phrase: string }
  | {
      form: 'sort';
      key: string;
      type: 'number' | 'text' | 'date';
      direction: 'ascending' | 'descending';
    }
  /** The audited records vocabulary: order by the column type the job declares. */
  | { form: 'typed_order' }
  /** The audited records vocabulary: order by comparing values as text. */
  | { form: 'text_order' };

const FORMS: readonly [RegExp, (match: RegExpExecArray) => StepForm][] = [
  [
    /^keep (?:it|the (?:summary|reply|message|draft|answer)) under (\d{1,4}) words$/i,
    (match) => ({ form: 'word_limit', max: Number(match[1]) }),
  ],
  [/^use bullet points$/i, () => ({ form: 'list', style: 'bullets' })],
  [/^use a numbered list$/i, () => ({ form: 'list', style: 'numbered' })],
  [
    /^start with "([^"]{1,60})"(?: on its own line)?$/i,
    (match) => ({ form: 'opening', phrase: match[1] ?? '' }),
  ],
  [
    /^sort (?:the )?(?:rows|records) by ([a-z_][a-z0-9_]{0,40}) as (number|text|date)s? (ascending|descending)$/i,
    (match) => ({
      form: 'sort',
      key: match[1] ?? '',
      type: (match[2] ?? 'text').toLowerCase() as 'number' | 'text' | 'date',
      direction: (match[3] ?? 'ascending').toLowerCase() as 'ascending' | 'descending',
    }),
  ],
  [
    /^order records using the declared column type: compare numeric values numerically, dates chronologically, and text lexically$/i,
    () => ({ form: 'typed_order' }),
  ],
  [/^use typed (?:chronological )?ordering$/i, () => ({ form: 'typed_order' })],
  [
    /^compare dates chronologically(?: using the declared date format)?$/i,
    () => ({ form: 'typed_order' }),
  ],
  [/^order records by comparing the selected values as text$/i, () => ({ form: 'text_order' })],
];

const recognise = (clause: string): StepForm | null => {
  const text = clause
    .trim()
    .replace(/[.!]+$/, '')
    .trim();
  for (const [pattern, build] of FORMS) {
    const match = pattern.exec(text);
    if (match) return build(match);
  }
  return null;
};

const VERBATIM = /^Owner's correction: "([\s\S]*)"$/;

/**
 * One step per line of a delivered body. A numbered prefix is allowed; the
 * sentence is the step's first sentence, so a records body line is read by its
 * leading instruction. A step that keeps the owner's words is read as a message.
 */
export function stepsFromBody(body: string): StepForm[] {
  const steps: StepForm[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim().replace(/^\d+\.\s+/, '');
    const verbatim = VERBATIM.exec(line);
    if (verbatim) {
      steps.push(...stepsFromMessage(verbatim[1] ?? ''));
      continue;
    }
    const first = line.split(/(?<=[.!])\s+/)[0] ?? '';
    const step = recognise(first);
    if (step) steps.push(step);
  }
  return steps;
}

/** Clauses split on sentence ends, colons, commas, semicolons and "and", never inside quotes. */
export function stepsFromMessage(text: string): StepForm[] {
  const clauses: string[] = [];
  let current = '';
  let quoted = false;
  for (const character of text) {
    if (character === '"') quoted = !quoted;
    if (!quoted && /[.;:,!?\n]/.test(character)) {
      clauses.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  clauses.push(current);
  const steps: StepForm[] = [];
  for (const clause of clauses)
    for (const part of splitOutsideQuotes(clause, / and (?:then )?/i)) {
      const step = recognise(part.trim().replace(/^(?:and|then)\s+/i, ''));
      if (step) steps.push(step);
    }
  return steps;
}

function splitOutsideQuotes(text: string, separator: RegExp): string[] {
  if (text.includes('"')) return [text];
  return text.split(separator);
}

// --------------------------------------------------------------------------
// Drafts
// --------------------------------------------------------------------------

const DEFAULT_SENTENCES = (objective: string) => [
  `Summary of the request: ${objective.replace(/\s+/g, ' ').trim().slice(0, 200)}.`,
  'The main points are set out here in full, with the background for each one.',
  'Several details repeat what came earlier, so that nothing is missed along the way.',
  'There are a few follow-up items that may need attention later in the week.',
  'Each of them is described with enough context to act on it without asking.',
  'Let me know if anything should be added or changed before this goes out.',
];

const tokens = (text: string) => text.split(/\s+/).filter(Boolean);

/** The answer a literal instruction-follower gives to a written request, after its steps. */
export function writeDraft(objective: string, steps: readonly StepForm[]): string {
  let opening: string | null = null;
  let lines = DEFAULT_SENTENCES(objective);
  let style: 'paragraph' | 'bullets' | 'numbered' = 'paragraph';
  let limit = Number.POSITIVE_INFINITY;
  for (const step of steps) {
    if (step.form === 'list') {
      // A list reformats everything written so far, an opening line included.
      if (opening) lines = [opening, ...lines];
      opening = null;
      style = step.style;
    } else if (step.form === 'opening') opening = step.phrase;
    else if (step.form === 'word_limit') limit = Math.min(limit, step.max);
  }
  const render = (body: readonly string[]) => {
    const rendered =
      style === 'bullets'
        ? body.map((line) => `- ${line}`).join('\n')
        : style === 'numbered'
          ? body.map((line, index) => `${index + 1}. ${line}`).join('\n')
          : body.join(' ');
    return opening ? `${opening}\n${rendered}` : rendered;
  };
  let kept = [...lines];
  while (kept.length > 1 && tokens(render(kept)).length > limit) kept = kept.slice(0, -1);
  const text = render(kept);
  const words = tokens(text);
  return words.length > limit ? words.slice(0, limit).join(' ') : text;
}

type Row = Record<string, string | number>;

const dateValue = (raw: unknown, dateFormat?: 'iso' | 'dmy') => {
  const text = String(raw);
  if (dateFormat === 'dmy' || /^\d{2}\/\d{2}\/\d{4}$/.test(text)) {
    const [day, month, year] = text.split('/');
    return Date.parse(`${year}-${month}-${day}T00:00:00Z`);
  }
  return Date.parse(text);
};

export function sortRows(
  rows: readonly Row[],
  step: Extract<StepForm, { form: 'sort' }>,
  dateFormat?: 'iso' | 'dmy',
): Row[] {
  if (!rows.every((row) => step.key in row)) return [...rows];
  const value = (row: Row): number | string =>
    step.type === 'number'
      ? Number(row[step.key])
      : step.type === 'date'
        ? dateValue(row[step.key], dateFormat)
        : String(row[step.key]);
  return [...rows].sort((left, right) => {
    const a = value(left);
    const b = value(right);
    const comparison = a < b ? -1 : a > b ? 1 : 0;
    return step.direction === 'ascending' ? comparison : -comparison;
  });
}
