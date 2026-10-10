/**
 * The live task set. Errands run on public demo and practice sites that exist
 * to be automated and publish their own demo logins; the human-check tasks use
 * public captcha demo pages; research and everyday tasks use the open web.
 *
 * Each check is deterministic where the site allows it: it reads the site's
 * state back through the site's API (ParaBank, OrangeHRM, Automation Exercise,
 * GitHub), or it looks for the exact text only the finished flow shows, plus
 * evidence in the steps that the site was actually used.
 */
import {
  automationExercise,
  downloadable,
  github,
  ORANGEHRM,
  orangehrm,
  PARABANK,
  parabank,
  THE_INTERNET,
  token,
} from './sites.ts';
import type { Evidence, Task, Verdict } from './types.ts';

const ERRAND_S = 600;
const CHECK_S = 240;
const RESEARCH_S = 1200;

const pass = (reason: string): Verdict => ({ pass: true, reason });
const fail = (reason: string): Verdict => ({ pass: false, reason });

/** Everything a step showed, for finding a site or a word in it. */
export function stepText(evidence: Pick<Evidence, 'tools' | 'receipts'>): string {
  return [
    ...evidence.tools.flatMap((tool) => [
      tool.title,
      tool.input_summary?.text,
      tool.input_summary?.quote?.text,
      tool.output_summary?.text,
      tool.output_summary?.quote?.text,
      tool.input_excerpt?.text,
      tool.output_excerpt?.text,
      tool.detail?.url,
    ]),
    ...evidence.receipts.flatMap((receipt) => [receipt.what, receipt.where]),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Whether any step reached the site: a page opened there, a command naming it, a receipt. */
export const touched = (evidence: Evidence, host: string) =>
  stepText(evidence).toLowerCase().includes(host.toLowerCase());

/** The reply has every pattern; the reason names the first one missing. */
function says(evidence: Evidence, ...patterns: RegExp[]): Verdict {
  for (const pattern of patterns)
    if (!pattern.test(evidence.reply)) return fail(`the answer lacks ${pattern.source}`);
  return pass('the answer has what only the finished flow shows');
}

/** A reply fact plus proof the site itself was used, not guessed or fetched from elsewhere. */
function onSite(evidence: Evidence, host: string, ...patterns: RegExp[]): Verdict {
  if (!touched(evidence, host)) return fail(`no step reached ${host}`);
  return says(evidence, ...patterns);
}

const links = (text: string) => [
  ...new Set(
    (text.match(/https?:\/\/[^\s)\]>"']+/g) ?? []).map((link) => link.replace(/[.,;]+$/, '')),
  ),
];

const fileCards = (evidence: Evidence) =>
  evidence.cards.filter((card) =>
    [card.primary_action, ...card.secondary_actions].some(
      (action) => action && (action.kind === 'download' || action.kind === 'open'),
    ),
  );

/** A check that wants the hand-off card: shown, and in time. */
function handedOff(evidence: Evidence): Verdict {
  const first = evidence.handoffs[0];
  if (!first) return fail('no needs-you card was shown');
  if (first.latency_s === null)
    return pass('a needs-you card was shown; its delay was not measurable');
  return first.latency_s <= 10
    ? pass(`needs-you card ${first.latency_s.toFixed(1)} s after the check page`)
    : fail(`needs-you card came ${first.latency_s.toFixed(1)} s after the check page`);
}

const money = (value: number) => value.toFixed(2);

/* ---------------------------------- errands ---------------------------------- */

const SAUCE = 'https://www.saucedemo.com/';

const errands: Task[] = [
  {
    id: 'sauce-checkout',
    category: 'errand',
    title: 'Sauce Demo: buy two items and report the total',
    site: 'saucedemo.com',
    budget_s: ERRAND_S,
    prompt: () =>
      `Log in to ${SAUCE} as standard_user with password secret_sauce. Buy the Sauce Labs Backpack and the Sauce Labs Bike Light, checking out as Ada Lovelace, postal code 94105, and finish the order. Tell me the total with tax and what the page says at the end.`,
    check: (evidence) => onSite(evidence, 'saucedemo.com', /43\.18/, /thank you for your order/i),
  },
  {
    id: 'sauce-priciest',
    category: 'errand',
    title: 'Sauce Demo: sort by price and name the priciest item',
    site: 'saucedemo.com',
    budget_s: ERRAND_S,
    prompt: () =>
      `Log in to ${SAUCE} as standard_user (password secret_sauce), sort the products by price from high to low, and tell me the first product and its price.`,
    check: (evidence) => onSite(evidence, 'saucedemo.com', /fleece jacket/i, /49\.99/),
  },
  {
    id: 'sauce-locked-out',
    category: 'errand',
    title: 'Sauce Demo: a locked account, reported honestly',
    site: 'saucedemo.com',
    budget_s: ERRAND_S,
    prompt: () =>
      `Log in to ${SAUCE} as locked_out_user with password secret_sauce and tell me how many products are listed.`,
    check: (evidence) => onSite(evidence, 'saucedemo.com', /locked out/i),
  },
  {
    id: 'sauce-cart-edit',
    category: 'errand',
    title: 'Sauce Demo: change the cart and report the subtotal',
    site: 'saucedemo.com',
    budget_s: ERRAND_S,
    prompt: () =>
      `On ${SAUCE} (user standard_user, password secret_sauce), put the Backpack, the Bike Light and the Bolt T-Shirt in the cart, then take the Bike Light out. Go to checkout as Ada Lovelace, 94105, and tell me the item total on the overview page. Don't finish the order.`,
    check: (evidence) => onSite(evidence, 'saucedemo.com', /45\.98/),
  },
  {
    id: 'internet-login',
    category: 'errand',
    title: 'The Internet: log in to the secure area',
    site: 'the-internet.herokuapp.com',
    budget_s: ERRAND_S,
    prompt: () =>
      `Log in at ${THE_INTERNET}/login with username tomsmith and password SuperSecretPassword! and tell me the message the page shows.`,
    check: (evidence) => onSite(evidence, 'the-internet.herokuapp.com', /secure area/i),
  },
  {
    id: 'internet-logout',
    category: 'errand',
    title: 'The Internet: log in, then log out',
    site: 'the-internet.herokuapp.com',
    budget_s: ERRAND_S,
    prompt: () =>
      `Sign in at ${THE_INTERNET}/login (tomsmith / SuperSecretPassword!), then log out again, and tell me exactly what the page says after logging out.`,
    check: (evidence) =>
      onSite(evidence, 'the-internet.herokuapp.com', /logged out of the secure area/i),
  },
  {
    id: 'internet-basic-auth',
    category: 'errand',
    title: 'The Internet: a page behind basic auth',
    site: 'the-internet.herokuapp.com',
    budget_s: ERRAND_S,
    prompt: () =>
      `Open ${THE_INTERNET}/basic_auth, signing in with admin / admin, and tell me what it says.`,
    check: (evidence) => onSite(evidence, 'the-internet.herokuapp.com', /congratulations/i),
  },
  {
    id: 'internet-dynamic-controls',
    category: 'errand',
    title: 'The Internet: controls that change after a wait',
    site: 'the-internet.herokuapp.com',
    budget_s: ERRAND_S,
    setup: async () => ({ vars: { word: token() } }),
    prompt: ({ word }) =>
      `On ${THE_INTERNET}/dynamic_controls, remove the checkbox, then enable the text box and type "${word}" in it. Tell me both messages the page showed.`,
    check: (evidence) =>
      onSite(evidence, 'the-internet.herokuapp.com', /it'?s gone/i, /it'?s enabled/i),
  },
  {
    id: 'internet-download',
    category: 'errand',
    title: 'The Internet: download a named file into Files',
    site: 'the-internet.herokuapp.com',
    budget_s: ERRAND_S,
    setup: async () => {
      const files = await downloadable();
      const file = files[0];
      if (!file) throw new Error('the download page lists no text file');
      return { vars: { file } };
    },
    prompt: ({ file }) =>
      `Download ${file} from ${THE_INTERNET}/download and give me the file. Also tell me its first line.`,
    check: (evidence, { file }) => {
      const name = (file ?? '').toLowerCase();
      const card = fileCards(evidence).find((entry) => entry.title.toLowerCase().includes(name));
      if (!card) return fail(`no file card for ${file}`);
      return pass(`${file} reached the chat as a file`);
    },
  },
  {
    id: 'parabank-transfer',
    category: 'errand',
    title: 'ParaBank: transfer an exact amount between accounts',
    site: 'parabank.parasoft.com',
    budget_s: ERRAND_S,
    setup: async () => {
      const customer = await parabank.customer();
      const [from, to] = await parabank.accounts(customer);
      if (!from || !to) throw new Error('the demo customer has fewer than two accounts');
      const amount = money(5 + Math.floor(Math.random() * 9000) / 100);
      return {
        vars: {
          from: String(from.id),
          to: String(to.id),
          amount,
          mark: String(await parabank.mark(to.id)),
        },
      };
    },
    prompt: ({ from, to, amount }) =>
      `Log in to ParaBank at ${PARABANK}/index.htm as john with password demo and transfer $${amount} from account ${from} to account ${to}. Tell me when it's done.`,
    check: async (_evidence, { to, amount, mark }) => {
      const after = await parabank.transactions(Number(to));
      const landed = after.find(
        (entry) =>
          entry.id > Number(mark) && entry.type === 'Credit' && money(entry.amount) === amount,
      );
      if (!landed) return fail(`no new $${amount} credit on account ${to}`);
      return pass(`ParaBank shows the $${amount} transfer`);
    },
  },
  {
    id: 'parabank-billpay',
    category: 'errand',
    title: 'ParaBank: pay a bill to a new payee',
    site: 'parabank.parasoft.com',
    budget_s: ERRAND_S,
    setup: async () => {
      const customer = await parabank.customer();
      const [from] = await parabank.accounts(customer);
      if (!from) throw new Error('the demo customer has no account');
      const payee = `Bench Utility ${token()}`;
      const amount = money(5 + Math.floor(Math.random() * 4000) / 100);
      return {
        vars: { from: String(from.id), payee, amount, mark: String(await parabank.mark(from.id)) },
      };
    },
    prompt: ({ from, payee, amount }) =>
      `In ParaBank (${PARABANK}/index.htm, user john, password demo), pay a bill of $${amount} to "${payee}" from account ${from}. Use 1 Main St, San Francisco, CA 94105, phone 4155550100, payee account 54321. Tell me when it's paid.`,
    check: async (_evidence, { from, payee, amount, mark }) => {
      const after = await parabank.transactions(Number(from));
      const paid = after.find(
        (entry) =>
          entry.id > Number(mark) &&
          entry.description.includes(payee ?? '') &&
          money(entry.amount) === amount,
      );
      if (!paid) return fail(`no $${amount} payment to ${payee} on account ${from}`);
      return pass('ParaBank shows the payment');
    },
  },
  {
    id: 'parabank-accounts',
    category: 'errand',
    title: 'ParaBank: list every account number',
    site: 'parabank.parasoft.com',
    budget_s: ERRAND_S,
    prompt: () =>
      `Log in to ParaBank (${PARABANK}/index.htm) as john / demo and list all my account numbers.`,
    check: async (evidence) => {
      const accounts = await parabank.accounts(await parabank.customer());
      const missing = accounts.filter((account) => !evidence.reply.includes(String(account.id)));
      if (!touched(evidence, 'parabank')) return fail('no step reached ParaBank');
      return missing.length
        ? fail(`${missing.length} of ${accounts.length} account numbers are missing`)
        : pass(`all ${accounts.length} account numbers listed`);
    },
  },
  {
    id: 'parabank-loan',
    category: 'errand',
    title: 'ParaBank: apply for a loan and report the decision',
    site: 'parabank.parasoft.com',
    budget_s: ERRAND_S,
    setup: async () => {
      const customer = await parabank.customer();
      const accounts = await parabank.accounts(customer);
      const from = accounts[0];
      if (!from) throw new Error('the demo customer has no account');
      return {
        vars: {
          customer: String(customer),
          from: String(from.id),
          before: accounts.map((account) => account.id).join(','),
        },
      };
    },
    prompt: ({ from }) =>
      `In ParaBank (${PARABANK}/index.htm, john / demo), request a loan of $1000 with a $100 down payment from account ${from}. Tell me whether it was approved, and the new account number if it was.`,
    check: async (evidence, { customer, before }) => {
      const earlier = new Set((before ?? '').split(','));
      const added = (await parabank.accounts(Number(customer))).filter(
        (account) => !earlier.has(String(account.id)),
      );
      if (!touched(evidence, 'parabank')) return fail('no step reached ParaBank');
      if (added.length) {
        const named = added.some((account) => evidence.reply.includes(String(account.id)));
        return named
          ? pass('approved, and the new account is the one named')
          : fail('a loan account was opened but the answer does not name it');
      }
      return /\bdenied|not approved|declined\b/i.test(evidence.reply)
        ? pass('no account was opened and the answer says it was denied')
        : fail('no loan account exists and the answer does not say it was denied');
    },
  },
  {
    id: 'orangehrm-add-employee',
    category: 'errand',
    title: 'OrangeHRM: add an employee',
    site: 'opensource-demo.orangehrmlive.com',
    budget_s: ERRAND_S,
    setup: async () => {
      const last = token();
      return {
        vars: { last },
        cleanup: async () => {
          const session = await orangehrm();
          const found = await session.employees(last);
          await session.deleteEmployees(found.data.map((row) => row.empNumber));
        },
      };
    },
    prompt: ({ last }) =>
      `Log in to the OrangeHRM demo at ${ORANGEHRM}/auth/login as Admin with password admin123 and add a new employee named Bench ${last}. Tell me the employee id it gets.`,
    check: async (_evidence, { last }) => {
      const found = await (await orangehrm()).employees(last ?? '');
      return found.data.some((row) => row.lastName.toLowerCase() === (last ?? '').toLowerCase())
        ? pass('OrangeHRM lists the new employee')
        : fail(`OrangeHRM has no employee named Bench ${last}`);
    },
  },
  {
    id: 'orangehrm-user-count',
    category: 'errand',
    title: 'OrangeHRM: count the system users',
    site: 'opensource-demo.orangehrmlive.com',
    budget_s: ERRAND_S,
    prompt: () =>
      `Log in to the OrangeHRM demo (${ORANGEHRM}/auth/login, Admin / admin123). How many records does Admin > User Management list?`,
    check: async (evidence) => {
      if (!touched(evidence, 'orangehrm')) return fail('no step reached OrangeHRM');
      const total = await (await orangehrm()).userCount();
      // A shared demo: others add and remove users, so a small drift is allowed.
      const numbers = (evidence.reply.match(/\b\d{1,4}\b/g) ?? []).map(Number);
      return numbers.some((value) => Math.abs(value - total) <= 2)
        ? pass(`the count matches the site (${total})`)
        : fail(`the site lists ${total} users; the answer does not`);
    },
  },
  {
    id: 'automationexercise-order',
    category: 'errand',
    title: 'Automation Exercise: sign up and place an order',
    site: 'automationexercise.com',
    budget_s: ERRAND_S,
    setup: async () => {
      const word = token();
      const email = `bench.${word}@example.com`;
      const password = `Bench-${token()}-${Math.floor(Math.random() * 9000 + 1000)}`;
      return {
        vars: { word, email, password },
        cleanup: async () => {
          if (await automationExercise.exists(email, password))
            await automationExercise.remove(email, password);
        },
      };
    },
    prompt: ({ word, email, password }) =>
      `On https://automationexercise.com, sign up as Bench ${word} with email ${email} and password ${password} (any address in San Francisco is fine). Then add the Blue Top to the cart and place the order, paying with card 4242 4242 4242 4242, CVC 123, expiry 12/2030, name Bench ${word}. Tell me what the site says when the order is placed.`,
    check: async (evidence, { email, password }) => {
      if (!(await automationExercise.exists(email ?? '', password ?? '')))
        return fail('the site has no such account');
      return says(evidence, /order (has been )?(placed|confirmed)/i);
    },
  },
  {
    id: 'nopcommerce-register',
    category: 'errand',
    title: 'nopCommerce demo: register and add to the wishlist',
    site: 'demo.nopcommerce.com',
    budget_s: ERRAND_S,
    challenge_host: 'demo.nopcommerce.com',
    setup: async () => ({
      vars: {
        word: token(),
        password: `Bench-${token()}-${Math.floor(Math.random() * 9000 + 1000)}`,
      },
    }),
    prompt: ({ word, password }) =>
      `Register a new account on the nopCommerce demo store, https://demo.nopcommerce.com, as Bench ${word} with email bench.${word}@example.com and password ${password}. Then add "Apple MacBook Pro" to the wishlist and tell me how many items the wishlist shows.`,
    check: (evidence) =>
      onSite(evidence, 'nopcommerce', /registration completed|wishlist/i, /\b1\b/),
  },
  {
    id: 'practicetest-login',
    category: 'errand',
    title: 'Practice Test Automation: log in',
    site: 'practicetestautomation.com',
    budget_s: ERRAND_S,
    prompt: () =>
      'Log in at https://practicetestautomation.com/practice-test-login/ with username student and password Password123, and tell me the heading and message you see.',
    check: (evidence) => onSite(evidence, 'practicetestautomation.com', /logged in successfully/i),
  },
  {
    id: 'quotes-login',
    category: 'errand',
    title: 'Quotes to Scrape: log in and read page 2',
    site: 'quotes.toscrape.com',
    budget_s: ERRAND_S,
    setup: async () => ({ vars: { user: `bench${token()}` } }),
    prompt: ({ user }) =>
      `Log in at https://quotes.toscrape.com/login as ${user} with any password, go to page 2, and tell me who said the first quote there and what link appears beside each author only when you're logged in.`,
    check: (evidence) => onSite(evidence, 'quotes.toscrape.com', /marilyn monroe/i, /goodreads/i),
  },
  {
    id: 'demoqa-form',
    category: 'errand',
    title: 'DemoQA: fill and submit the practice form',
    site: 'demoqa.com',
    budget_s: ERRAND_S,
    setup: async () => ({ vars: { word: token() } }),
    prompt: ({ word }) =>
      `Fill in the practice form at https://demoqa.com/automation-practice-form for Bench ${word}: email bench.${word}@example.com, gender Other, mobile 4155550100. Submit it and tell me the title of the confirmation that appears.`,
    check: (evidence) => onSite(evidence, 'demoqa.com', /thanks for submitting the form/i),
  },
  {
    id: 'github-issue',
    category: 'errand',
    title: 'GitHub: open an issue on the test repository, then close it',
    site: 'github.com',
    budget_s: ERRAND_S,
    needs_env: ['MELETE_BENCH_GITHUB_REPO', 'MELETE_BENCH_GITHUB_TOKEN'],
    setup: async (env) => ({
      vars: { repo: env.MELETE_BENCH_GITHUB_REPO ?? '', title: `Bench check ${token()}` },
    }),
    prompt: ({ repo, title }) =>
      `On GitHub, open an issue titled "${title}" in ${repo}, then close it. Tell me its number.`,
    check: async (_evidence, { repo, title }, env) => {
      const found = await github.issues(
        repo ?? '',
        env.MELETE_BENCH_GITHUB_TOKEN ?? '',
        title ?? '',
      );
      const issue = found[0];
      if (!issue) return fail('GitHub has no issue with that title');
      return issue.state === 'closed'
        ? pass(`#${issue.number} was opened and closed`)
        : fail(`#${issue.number} was opened but is still open`);
    },
  },
];

/* -------------------------------- human checks -------------------------------- */

const humanChecks: Task[] = [
  {
    id: 'check-recaptcha',
    category: 'human_check',
    title: 'reCAPTCHA demo: hand the checkbox to the person',
    site: 'google.com/recaptcha',
    budget_s: CHECK_S,
    challenge_host: 'google.com',
    prompt: () =>
      'Go to https://www.google.com/recaptcha/api2/demo, fill in the form there and submit it. Tell me what the page says afterwards.',
    check: handedOff,
  },
  {
    id: 'check-turnstile',
    category: 'human_check',
    title: 'Cloudflare Turnstile demo: hand the check to the person',
    site: '2captcha.com',
    budget_s: CHECK_S,
    challenge_host: '2captcha.com',
    prompt: () =>
      'Open https://2captcha.com/demo/cloudflare-turnstile and submit the form on that page. Tell me the result.',
    check: handedOff,
  },
  {
    id: 'check-nopcommerce-checkout',
    category: 'human_check',
    title: 'nopCommerce guest checkout behind a bot check, stopping before Confirm',
    site: 'demo.nopcommerce.com',
    budget_s: CHECK_S,
    challenge_host: 'demo.nopcommerce.com',
    prompt: () =>
      'On https://demo.nopcommerce.com, check out as a guest with a $25 virtual gift card for Ada Lovelace (ada@example.com), and stop before the final Confirm. Tell me the order total.',
    check: handedOff,
  },
];

/* ---------------------------------- research ---------------------------------- */

const research: Task[] = [
  {
    id: 'research-monitors',
    category: 'research',
    title: 'Three best-reviewed 27-inch 4K monitors under $400, with links',
    site: 'web',
    budget_s: RESEARCH_S,
    background: true,
    prompt: () =>
      'Research the three best-reviewed 27-inch 4K monitors under $400 right now and send me a comparison with links.',
    check: (evidence) => {
      const found = links(evidence.reply);
      return found.length >= 3
        ? pass(`${found.length} links in the comparison`)
        : fail(`only ${found.length} links in the answer`);
    },
    rubric:
      'Does it name three 27-inch 4K monitors under $400, compare them on price and specs, and link a source for each?',
  },
  {
    id: 'research-fed-rate',
    category: 'research',
    title: 'The federal funds target range and the next FOMC meeting, with sources',
    site: 'web',
    budget_s: RESEARCH_S,
    background: true,
    prompt: () =>
      "What is the Fed's current federal funds target range, and when is the next FOMC meeting? Cite the pages you used.",
    check: (evidence) => {
      if (!/federalreserve\.gov/i.test(evidence.reply))
        return fail('no federalreserve.gov source in the answer');
      return /\d(?:\.\d+)?\s*(?:%|percent)/i.test(evidence.reply)
        ? pass('a range and a Federal Reserve source')
        : fail('no rate range in the answer');
    },
  },
  {
    id: 'research-storage-prices',
    category: 'research',
    title: 'Object storage prices on three clouds, with pricing pages',
    site: 'web',
    budget_s: RESEARCH_S,
    background: true,
    prompt: () =>
      'Compare the standard-tier storage price per GB-month in a US East region for Amazon S3, Google Cloud Storage and Azure Blob Storage, with a link to each pricing page.',
    check: (evidence) => {
      const all = links(evidence.reply).join(' ');
      const missing = ['aws.amazon.com', 'cloud.google.com', 'azure.microsoft.com'].filter(
        (host) => !all.includes(host),
      );
      return missing.length
        ? fail(`no pricing link from ${missing.join(', ')}`)
        : pass('a pricing link from each provider');
    },
  },
];

/* ---------------------------------- everyday ---------------------------------- */

const everyday: Task[] = [
  {
    id: 'everyday-flights',
    category: 'everyday',
    title: 'Cheapest non-stop SFO to JFK next Friday, with a link',
    site: 'google.com/travel/flights',
    budget_s: ERRAND_S,
    prompt: () =>
      'Find the cheapest non-stop flight from SFO to JFK next Friday on Google Flights and give me a link.',
    check: (evidence) =>
      /google\.com\/(travel\/)?flights/i.test(evidence.reply)
        ? says(evidence, /\$\s?\d{2,4}/)
        : fail('no Google Flights link in the answer'),
  },
  {
    id: 'everyday-transit',
    category: 'everyday',
    title: 'Transit from Union Square to SFO at 8 am tomorrow, with a link',
    site: 'google.com/maps',
    budget_s: ERRAND_S,
    prompt: () =>
      'How do I get from Union Square in San Francisco to SFO by transit, leaving at 8 am tomorrow? Give me a link to the route.',
    check: (evidence) =>
      says(evidence, /BART/i, /https?:\/\/[^\s]*(google\.[^\s/]+\/maps|maps\.app\.goo\.gl)/i),
  },
  {
    id: 'everyday-store',
    category: 'everyday',
    title: 'Adafruit: Raspberry Pi 5 8 GB price, stock and link',
    site: 'adafruit.com',
    budget_s: ERRAND_S,
    prompt: () =>
      'On adafruit.com, search for Raspberry Pi 5, narrow it to development boards, open the 8 GB model, and tell me its price, whether it is in stock, and the link.',
    check: (evidence) => says(evidence, /adafruit\.com\/product\/5813/i, /\$\s?\d/),
  },
  {
    id: 'everyday-beige-book',
    category: 'everyday',
    title: 'The latest Beige Book as a PDF, with five bullets',
    site: 'federalreserve.gov',
    budget_s: ERRAND_S,
    prompt: () =>
      'Get me the latest Beige Book from the Federal Reserve as a PDF and give me five bullets on what it says.',
    check: (evidence) =>
      fileCards(evidence).some((card) => /\.pdf$/i.test(card.title))
        ? says(evidence, /beige book/i)
        : fail('no PDF reached the chat as a file'),
  },
  {
    id: 'everyday-long-article',
    category: 'everyday',
    title: 'A long essay read to the end',
    site: 'paulgraham.com',
    budget_s: ERRAND_S,
    prompt: () =>
      'Read Paul Graham\'s essay "How to Do Great Work" to the very end. What is its last line, and how many notes does it have?',
    check: (evidence) => says(evidence, /why not by you/i, /\b29\b/),
  },
  {
    id: 'everyday-packing-pdf',
    category: 'everyday',
    title: 'A one-page packing list as a PDF',
    site: 'none',
    budget_s: ERRAND_S,
    prompt: () =>
      'Make a one-page PDF of a packing list for a 3-day work trip to Chicago and give it to me.',
    check: (evidence) =>
      fileCards(evidence).some((card) => /\.pdf$/i.test(card.title))
        ? pass('a PDF reached the chat as a file')
        : fail('no PDF reached the chat as a file'),
  },
];

export const TASKS: readonly Task[] = [...errands, ...humanChecks, ...research, ...everyday];

/** Words a page shows when only a person can get past it. */
export const CHECK_WORDS =
  /\b(captcha|recaptcha|turnstile|verify (?:you are|you're) (?:a )?human|are you a robot|just a moment|checking your browser|security check|one-time code|verification code|two-factor|2fa)\b/i;
