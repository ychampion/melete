/**
 * Reading a page back after a browser submit, to say whether it took.
 *
 * A form sent is not an effect done: the site may have shown an error, sent
 * the same form back, or stopped at a check only a person can pass. This
 * reads the page the submit ended on and says `done`, `not_done` or
 * `unclear`, with the one thing on the page that decided it. Anything the
 * words cannot settle either way is `unclear`, which stops the work and puts
 * it to the person: a guess would be a booking made twice, or never.
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
};

/** The form that was sent. */
export type SentForm = { url: string; name: string; form_hash: string };

const CAPTCHA =
  /\b(captcha|recaptcha|hcaptcha|i(?:'|’)?m not a robot|are you a robot|verify (?:that )?you(?:'|’)?re? (?:a )?human|prove you(?:'|’)?re human|human verification|security check)\b/i;
const TWO_FACTOR =
  /\b(verification code|one[- ]time (?:pass)?code|one[- ]time password|two[- ]factor|2[- ]?step verification|2fa|authenticator app|enter the code (?:we )?sent|security code (?:we )?sent|confirm it(?:'|’)?s you)\b/i;
const PAYMENT =
  /\b(card number|credit card|debit card|cvv|cvc|security code on (?:the|your) card|expiry date|expiration date|billing address|pay now|place (?:your )?order and pay)\b/i;

const CONFIRMED =
  /\b(thank you|thanks for|confirmed|confirmation (?:number|code|#)|you(?:'|’)re (?:all set|booked|confirmed)|successfully|(?:is|are|has been|have been) (?:sent|submitted|received|booked|scheduled|placed|confirmed|saved|reserved|complete)|(?:was|were) (?:sent|submitted|received|booked|scheduled|placed|saved)|we(?:'|’)ve (?:received|got)|we have received|booking (?:reference|confirmed|number)|reservation (?:is )?confirmed|order (?:number|#|placed|confirmed)|request (?:received|submitted)|message sent)\b/i;
const FAILED =
  /\b(error|invalid|failed|try again|could ?n(?:o|')t|unable to|(?:is|are) required|please (?:enter|correct|fix|check)|went wrong|no longer available|not available|declined|rejected|denied)\b/i;

/** Lines of the snapshot that speak about the page's outcome rather than its furniture. */
const SPEAKING = /^\s*-\s*(alert|status|heading|alertdialog|dialog|paragraph|text)\b/i;
/** Of those, the ones a site uses to announce an outcome, rather than body text. */
const ANNOUNCING = /^\s*-\s*(alert|status|heading|alertdialog|dialog)\b/i;
/**
 * The line a site using a bot check must show somewhere, often in its footer
 * ("This site is protected by reCAPTCHA and the Google Privacy Policy..."). It
 * names the check without asking anyone to pass it.
 */
const BOT_CHECK_NOTICE = /\bprotected by (?:re|h)?captcha\b/i;

function speaking(page: Pick<PageSeen, 'title' | 'tree'>, lines: RegExp = SPEAKING): string {
  const said = page.tree.split('\n').filter((line) => lines.test(line));
  return [page.title ?? '', ...said].join('\n');
}

/**
 * Something on the page only the person can get past, or null. A check that
 * a person is there can sit anywhere on the page; a code or a card is asked
 * for by a field or by what the page says, never by a footer link about them.
 */
export function blockerOf(page: Pick<PageSeen, 'title' | 'tree' | 'schema'>): PageBlocker | null {
  const labels = page.schema.map((control) => control.label).join('\n');
  const tree = page.tree
    .split('\n')
    .filter((line) => !BOT_CHECK_NOTICE.test(line))
    .join('\n');
  if (CAPTCHA.test(`${page.title ?? ''}\n${tree}\n${labels}`)) return 'captcha';
  const asked = `${speaking({ title: page.title, tree })}\n${labels}`;
  if (TWO_FACTOR.test(asked)) return 'two_factor';
  if (PAYMENT.test(labels)) return 'payment';
  return null;
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
  if (blocker)
    return result(
      'unclear',
      blocker === 'captcha'
        ? 'The page asks to prove a person is there.'
        : blocker === 'two_factor'
          ? 'The page asks for a code sent to the person.'
          : 'The page asks for payment details.',
      blocker,
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
  if (formBack) return result('unclear', 'The same form is back with nothing said about it.');
  return result('unclear', 'The page says nothing about whether it went through.');
}
