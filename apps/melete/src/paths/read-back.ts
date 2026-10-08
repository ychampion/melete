/**
 * Reading a page back after a browser submit, to say whether it took.
 *
 * A form sent is not an effect done: the site may have shown an error, sent
 * the same form back, or stopped at a check only a person can pass. This
 * reads the page the submit ended on and says `done`, `not_done` or
 * `unclear`, with the one thing on the page that decided it. A page that
 * shows back what was sent must show all of it: a value that never reached
 * the site makes it `not_done`, naming the field. Anything the page cannot
 * settle either way is `unclear`: a guess would be a booking made twice, or
 * never. What happens next (asking the person, or noting it unconfirmed) is
 * the connector's call, by whether the submit was one only the person lets
 * through.
 *
 * It is a pure function of the page, so every rule is pinned by a test.
 */
import type { PageBlocker, ReadBack } from '@melete/contracts';

/** What the browser saw after the submit. */
export type PageSeen = {
  url: string;
  title?: string;
  /** The page's accessibility snapshot: one line per element, `- role "name"` or `- role: text`. */
  tree: string;
  schema: ReadonlyArray<{ label: string; role: string; sensitive?: boolean }>;
  /** Forms on the page that could be sent next. */
  forms: ReadonlyArray<{ url: string; name: string; form_hash: string }>;
  /** The HTTP status the form's POST got, when the browser saw it. */
  status?: number | null;
  /** The browser found a visible bot-check widget or frame on the page (from its structure). */
  challenge?: boolean;
};

/** The form that was sent, with the values it carried. */
export type SentForm = {
  url: string;
  name: string;
  form_hash: string;
  fields?: Readonly<Record<string, string>>;
};

const CONFIRMED =
  /\b(thank you|thanks for|confirmed|confirmation (?:number|code|#)|you(?:'|’)re (?:all set|booked|confirmed)|successfully|(?:is|are|has been|have been) (?:sent|submitted|received|booked|scheduled|placed|confirmed|saved|reserved|complete)|(?:was|were) (?:sent|submitted|received|booked|scheduled|placed|saved)|we(?:'|’)ve (?:received|got)|we have received|booking (?:reference|confirmed|number)|reservation (?:is )?confirmed|order (?:number|#|placed|confirmed)|request (?:received|submitted)|message sent)\b/i;
const FAILED =
  /\b(error|invalid|failed|try again|could ?n(?:o|')t|unable to|(?:is|are) required|please (?:enter|correct|fix|check)|went wrong|no longer available|not available|declined|rejected|denied)\b/i;

/** Lines of the snapshot that speak about the page's outcome rather than its furniture. */
const SPEAKING = /^\s*-\s*(alert|status|heading|alertdialog|dialog|paragraph|text)\b/i;
/** Of those, the ones a site uses to announce an outcome, rather than body text. */
const ANNOUNCING = /^\s*-\s*(alert|status|heading|alertdialog|dialog)\b/i;

function speaking(page: Pick<PageSeen, 'title' | 'tree'>, lines: RegExp = SPEAKING): string {
  const said = page.tree.split('\n').filter((line) => lines.test(line));
  return [page.title ?? '', ...said].join('\n');
}

/**
 * Something on the page only the person can get past, or null, read from the
 * page's structure and never its words: a visible bot-check widget or frame.
 * A password, code or card field stops the browser before any page is seen
 * (the worker refuses to look at it), and that hands the work over by itself.
 */
export function blockerOf(page: Pick<PageSeen, 'challenge'>): PageBlocker | null {
  return page.challenge === true ? 'captcha' : null;
}

/** Text as one spelling for finding a value in it: lower case, spaces run together. */
const plain = (text: string) => text.toLowerCase().replace(/\s+/g, ' ');

/** Values shorter than this are too common to tell whether a page shows them back. */
const ECHO_MIN = 3;

/**
 * Whether a page that shows back what was sent shows all of it. A page counts
 * as showing input back when it names at least two of the sent fields beside
 * their values (an echo or review page, not a thank-you note). Then every
 * value of three characters or more must be on it, and the fields whose values
 * are missing are returned. Null when the page does not show input back.
 */
export function echoMissing(
  sent: SentForm,
  page: Pick<PageSeen, 'title' | 'tree'>,
): string[] | null {
  const fields = Object.entries(sent.fields ?? {}).filter(
    ([, value]) => value.trim().length >= ECHO_MIN,
  );
  if (fields.length < 2) return null;
  const text = plain(`${page.title ?? ''}\n${page.tree}`);
  const shows = (value: string) => text.includes(plain(value.trim()));
  const named = fields.filter(
    ([name, value]) => name.length >= ECHO_MIN && text.includes(plain(name)) && shows(value),
  );
  if (named.length < 2) return null;
  return fields.filter(([, value]) => !shows(value)).map(([name]) => name);
}

const first = (pattern: RegExp, text: string): string =>
  (pattern.exec(text)?.[0] ?? '').slice(0, 80);

/**
 * What the page says about the form that was sent. `looks` is which reading
 * this is; a second follows an unclear first, after the page has had time to settle.
 */
export function readBack(sent: SentForm, page: PageSeen | null, looks: 1 | 2 = 1): ReadBack {
  const result = (
    verdict: ReadBack['verdict'],
    evidence: string,
    blocker: PageBlocker | null = null,
  ): ReadBack => ({ verdict, blocker, evidence, looks, url: page?.url ?? null });
  if (!page) return result('unclear', 'The page after the submit could not be read.');
  // A server error says nothing about whether the form was taken: a gateway in
  // front of a site that saved it answers 502 or 504 all the same.
  if (typeof page.status === 'number' && page.status >= 500)
    return result(
      'unclear',
      `The site answered ${page.status} to the form, which does not say whether it went through.`,
    );
  if (typeof page.status === 'number' && page.status >= 400)
    return result('not_done', `The site answered ${page.status} to the form.`);
  const blocker = blockerOf(page);
  if (blocker) return result('unclear', 'The page asks to prove a person is there.', blocker);
  // A page that shows back what it got, and leaves a value out, did not get it.
  const missing = echoMissing(sent, page);
  if (missing?.length)
    return result(
      'not_done',
      `The page shows what was sent except ${missing.slice(0, 8).join(', ')}.`.slice(0, 300),
    );
  const said = speaking(page);
  const confirmed = CONFIRMED.test(said);
  const formBack = page.forms.some(
    (form) =>
      form.form_hash === sent.form_hash || (form.url === sent.url && form.name === sent.name),
  );
  // Failure words decide only where a site announces an outcome, or beside the
  // same form sent back. In body text alone they are too often about something
  // else ("Unable to make it? Cancel below"), and a submit taken for not done
  // when it was done is sent again.
  const refusal = formBack ? said : speaking(page, ANNOUNCING);
  const failed = FAILED.test(refusal);
  if (confirmed && FAILED.test(said))
    return result(
      'unclear',
      `The page says both "${first(CONFIRMED, said)}" and "${first(FAILED, said)}".`,
    );
  if (confirmed) return result('done', `The page says "${first(CONFIRMED, said)}".`);
  if (failed) return result('not_done', `The page says "${first(FAILED, refusal)}".`);
  if (missing && !formBack) return result('done', 'The page shows every value that was sent.');
  if (formBack) return result('unclear', 'The same form is back with nothing said about it.');
  return result('unclear', 'The page says nothing about whether it went through.');
}
