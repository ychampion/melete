/**
 * The live task set, in two tiers.
 *
 * Practice: errands on public demo sites that exist to be automated and publish
 * their own demo logins, and human checks on captcha demo pages. They lack the
 * bot checks, two-step logins and real accounts that real sites have, so they
 * are regression checks and never count toward a bar.
 *
 * Real: read-only lookups on real, bot-protected sites; logged-in errands on
 * accounts that really exist (the GitHub test account, plus slots for accounts
 * the owner may add, skipped until then); a real two-step check where one is
 * available; research and everyday asks on the open web. Only these are scored.
 *
 * Each check is deterministic where the site allows it: it reads the site's
 * state back through the site's API (ParaBank, OrangeHRM, Automation Exercise,
 * GitHub), or it looks for the exact text only the finished flow shows, plus
 * evidence in the steps that the site was actually used.
 */
import {
  automationExercise,
  downloadable,
  featuredArticle,
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

/** A real-account slot's answer holds what the owner read off the account. */
function expected(evidence: Evidence, wanted: string | undefined): Verdict {
  if (!wanted) return fail('no expected answer was set');
  return evidence.reply.toLowerCase().includes(wanted.toLowerCase())
    ? pass('the answer has what the account shows')
    : fail('the answer lacks what the account shows');
}

const money = (value: number) => value.toFixed(2);

/* ---------------------------------- errands ---------------------------------- */

const SAUCE = 'https://www.saucedemo.com/';

const errands: Task[] = [
  {
    id: 'sauce-checkout',
    category: 'errand',
    tier: 'practice',
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
    tier: 'practice',
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
    tier: 'practice',
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
    tier: 'practice',
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
    tier: 'practice',
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
    tier: 'practice',
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
    tier: 'practice',
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
    tier: 'practice',
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
    tier: 'practice',
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
    tier: 'practice',
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
    tier: 'practice',
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
    tier: 'practice',
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
    tier: 'practice',
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
    tier: 'practice',
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
    tier: 'practice',
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
    tier: 'practice',
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
    tier: 'practice',
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
    tier: 'practice',
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
    tier: 'practice',
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
    tier: 'practice',
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
    tier: 'real',
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
  {
    id: 'github-repo-settings',
    category: 'errand',
    tier: 'real',
    title: "GitHub: read the test repository's default branch and visibility",
    site: 'github.com',
    budget_s: ERRAND_S,
    needs_env: ['MELETE_BENCH_GITHUB_REPO', 'MELETE_BENCH_GITHUB_TOKEN'],
    setup: async (env) => ({ vars: { repo: env.MELETE_BENCH_GITHUB_REPO ?? '' } }),
    prompt: ({ repo }) =>
      `On GitHub, look at the settings of ${repo}: what is its default branch, and is it public or private? Don't change anything.`,
    check: async (evidence, { repo }, env) => {
      const settings = await github.repo(repo ?? '', env.MELETE_BENCH_GITHUB_TOKEN ?? '');
      const reply = evidence.reply.toLowerCase();
      if (!reply.includes(settings.default_branch.toLowerCase()))
        return fail(`the answer lacks the default branch ${settings.default_branch}`);
      const visibility = settings.private ? 'private' : 'public';
      if (!reply.includes(visibility)) return fail(`the answer does not say it is ${visibility}`);
      return pass(`${settings.default_branch}, ${visibility}, as GitHub has it`);
    },
  },
  {
    id: 'github-notifications',
    category: 'errand',
    tier: 'real',
    title: "GitHub: count the test account's unread notifications and name the newest",
    site: 'github.com',
    budget_s: ERRAND_S,
    needs_env: ['MELETE_BENCH_GITHUB_TOKEN'],
    prompt: () =>
      "How many unread GitHub notifications do I have, and what is the newest one about? Don't mark anything as read.",
    check: async (evidence, _vars, env) => {
      const unread = await github.unread(env.MELETE_BENCH_GITHUB_TOKEN ?? '');
      const count = unread.length;
      const word = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][
        count
      ];
      const said = new RegExp(`\\b(${count}${word ? `|${word}` : ''})\\b`, 'i');
      if (!said.test(evidence.reply)) return fail(`the answer does not give the count, ${count}`);
      const newest = unread[0]?.subject.title;
      if (newest && !evidence.reply.toLowerCase().includes(newest.slice(0, 30).toLowerCase()))
        return fail('the answer does not name the newest notification');
      return pass(`${count} unread, as GitHub has it`);
    },
  },
  /*
   * Slots for real accounts the owner may provide. Each is skipped as "account
   * not provided" until its variables are set: the agent's browser is signed in
   * to the account, and the EXPECT variable holds what the answer must contain,
   * read off the account by the owner. None is ever run against a stand-in.
   */
  {
    id: 'account-email',
    category: 'errand',
    tier: 'real',
    slot: 'a throwaway email account',
    title: 'Email: the subject of the newest message from a given sender',
    site: 'email',
    budget_s: ERRAND_S,
    needs_env: ['MELETE_BENCH_EMAIL_URL', 'MELETE_BENCH_EMAIL_FROM', 'MELETE_BENCH_EMAIL_EXPECT'],
    setup: async (env) => ({
      vars: { inbox: env.MELETE_BENCH_EMAIL_URL ?? '', from: env.MELETE_BENCH_EMAIL_FROM ?? '' },
    }),
    prompt: ({ inbox, from }) =>
      `Open my email at ${inbox} (you're signed in there in your browser) and tell me the subject of the newest message from ${from}. Don't send, delete or move anything.`,
    check: (evidence, _vars, env) => expected(evidence, env.MELETE_BENCH_EMAIL_EXPECT),
  },
  {
    id: 'account-reddit',
    category: 'errand',
    tier: 'real',
    slot: 'a Reddit account',
    title: 'Reddit: the title of the newest saved post',
    site: 'reddit.com',
    budget_s: ERRAND_S,
    needs_env: ['MELETE_BENCH_REDDIT_EXPECT'],
    prompt: () =>
      "On reddit.com, where you're signed in in your browser, open my saved posts and tell me the title of the newest one. Don't post, vote or unsave anything.",
    check: (evidence, _vars, env) => expected(evidence, env.MELETE_BENCH_REDDIT_EXPECT),
  },
  {
    id: 'account-store',
    category: 'errand',
    tier: 'real',
    slot: 'a store account',
    title: 'Store: the date and total of the most recent order',
    site: 'store',
    budget_s: ERRAND_S,
    needs_env: ['MELETE_BENCH_STORE_URL', 'MELETE_BENCH_STORE_EXPECT'],
    setup: async (env) => ({ vars: { store: env.MELETE_BENCH_STORE_URL ?? '' } }),
    prompt: ({ store }) =>
      `On ${store}, where you're signed in in your browser, find my most recent order and tell me its date and total. Look only; don't buy, cancel or return anything.`,
    check: (evidence, _vars, env) => expected(evidence, env.MELETE_BENCH_STORE_EXPECT),
  },
];

/* -------------------------------- human checks -------------------------------- */

const humanChecks: Task[] = [
  {
    id: 'check-recaptcha',
    category: 'human_check',
    tier: 'practice',
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
    tier: 'practice',
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
    tier: 'practice',
    title: 'nopCommerce guest checkout behind a bot check, stopping before Confirm',
    site: 'demo.nopcommerce.com',
    budget_s: CHECK_S,
    challenge_host: 'demo.nopcommerce.com',
    prompt: () =>
      'On https://demo.nopcommerce.com, check out as a guest with a $25 virtual gift card for Ada Lovelace (ada@example.com), and stop before the final Confirm. Tell me the order total.',
    check: handedOff,
  },
  {
    // GitHub asks for the password or a two-step code again (sudo mode) before
    // its security settings, in a browser signed in to the account.
    id: 'check-github-sudo',
    category: 'human_check',
    tier: 'real',
    slot: "the GitHub test account signed in in the agent's browser",
    title: 'GitHub sudo prompt: hand the two-step check to the person',
    site: 'github.com',
    budget_s: CHECK_S,
    challenge_host: 'github.com',
    needs_env: ['MELETE_BENCH_GITHUB_BROWSER'],
    prompt: () =>
      "In your browser, where you're signed in to GitHub, open https://github.com/settings/security and tell me whether two-factor authentication is on. Don't change anything.",
    check: handedOff,
  },
];

/* ---------------------------------- research ---------------------------------- */

const research: Task[] = [
  {
    id: 'research-monitors',
    category: 'research',
    tier: 'real',
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
    tier: 'real',
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
    tier: 'real',
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

/* ----------------------------------- lookups ---------------------------------- */

/*
 * Read-only lookups on real sites that guard themselves against bots. Nothing is
 * bought, booked or submitted. A bot check here is met for real, and the
 * needs-you card for it is timed against the bar.
 */
const lookups: Task[] = [
  {
    id: 'lookup-flights',
    category: 'lookup',
    tier: 'real',
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
    id: 'lookup-transit',
    category: 'lookup',
    tier: 'real',
    title: 'Transit from Union Square to SFO at 8 am tomorrow, with a link',
    site: 'google.com/maps',
    budget_s: ERRAND_S,
    prompt: () =>
      'How do I get from Union Square in San Francisco to SFO by transit, leaving at 8 am tomorrow? Give me a link to the route.',
    check: (evidence) =>
      says(evidence, /BART/i, /https?:\/\/[^\s]*(google\.[^\s/]+\/maps|maps\.app\.goo\.gl)/i),
  },
  {
    id: 'lookup-bestbuy',
    category: 'lookup',
    tier: 'real',
    title: 'Best Buy: the price of AirPods Pro 2, with the product link',
    site: 'bestbuy.com',
    budget_s: ERRAND_S,
    prompt: () =>
      "On bestbuy.com, look up Apple AirPods Pro 2 (USB-C) and tell me today's price and the link to the product page. Don't add anything to a cart.",
    check: (evidence) => says(evidence, /bestbuy\.com\/(site|product)\//i, /\$\s?\d/),
  },
  {
    id: 'lookup-kayak',
    category: 'lookup',
    tier: 'real',
    title: 'Kayak: the cheapest downtown Chicago hotel for two nights, with a link',
    site: 'kayak.com',
    budget_s: ERRAND_S,
    prompt: () =>
      'On kayak.com, find the cheapest hotel in downtown Chicago for two nights starting four weeks from today, one adult. Give me its name, the total price and a link. Look only; do not book or reserve anything.',
    check: (evidence) => says(evidence, /kayak\.com/i, /\$\s?\d/),
  },
  {
    id: 'lookup-zillow',
    category: 'lookup',
    tier: 'real',
    title: 'Zillow: the cheapest home for sale in 94110, with a link',
    site: 'zillow.com',
    budget_s: ERRAND_S,
    prompt: () =>
      'On zillow.com, what is the cheapest home for sale in the 94110 ZIP code right now? Give me the asking price, the address and the link. Look only; do not contact anyone.',
    check: (evidence) => says(evidence, /zillow\.com/i, /\$\s?\d/),
  },
  {
    id: 'lookup-wikipedia',
    category: 'lookup',
    tier: 'real',
    title: "Wikipedia: today's featured article",
    site: 'en.wikipedia.org',
    budget_s: ERRAND_S,
    setup: async () => ({ vars: { featured: await featuredArticle() } }),
    prompt: () =>
      "What is today's featured article on English Wikipedia? Give me its title and link.",
    check: (evidence, { featured }) =>
      evidence.reply.toLowerCase().includes((featured ?? '').toLowerCase())
        ? pass(`named ${featured}`)
        : fail(`the answer does not name ${featured}`),
  },
  {
    id: 'lookup-cloudflare',
    category: 'lookup',
    tier: 'real',
    title: "G2, behind Cloudflare: Notion's rating and review count, with a link",
    site: 'g2.com',
    budget_s: ERRAND_S,
    prompt: () =>
      "On g2.com, what is Notion's average star rating and how many reviews does it have? Give me the link to its G2 page.",
    check: (evidence) => says(evidence, /g2\.com\/products\//i, /\b[1-5]\.\d\b/),
  },
];

/* ---------------------------------- everyday ---------------------------------- */

const everyday: Task[] = [
  {
    id: 'everyday-store',
    category: 'everyday',
    tier: 'real',
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
    tier: 'real',
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
    tier: 'real',
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
    tier: 'real',
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

export const TASKS: readonly Task[] = [
  ...errands,
  ...humanChecks,
  ...research,
  ...lookups,
  ...everyday,
];

/** Words a page shows when only a person can get past it. */
export const CHECK_WORDS =
  /\b(captcha|recaptcha|turnstile|verify (?:you are|you're) (?:a )?human|are you a robot|just a moment|checking your browser|security check|one-time code|verification code|two-factor|2fa)\b/i;
