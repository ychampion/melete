/**
 * Reading the practice sites back after a job. Each of these is a public demo
 * built for automation, with its own published demo login; the benchmark reads
 * its state through the site's own API where it has one, so a check sees what
 * happened on the site rather than what the reply says happened.
 */

const json = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: { accept: 'application/json', ...(init.headers as Record<string, string>) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`);
  return (await response.json()) as T;
};

/** Short, letters-only, so it survives name fields that refuse digits. */
export function token(random: () => number = Math.random): string {
  const letters = 'abcdefghijkmnpqrstuvwxyz';
  let out = '';
  for (let i = 0; i < 6; i++) out += letters[Math.floor(random() * letters.length)];
  return out;
}

/* ---------- ParaBank: parabank.parasoft.com, demo login john / demo ---------- */

export const PARABANK = 'https://parabank.parasoft.com/parabank';
const PARABANK_API = `${PARABANK}/services/bank`;
export type ParabankAccount = { id: number; type: string; balance: number };
export type ParabankTransaction = {
  id: number;
  accountId: number;
  type: string;
  amount: number;
  description: string;
};

export const parabank = {
  async customer(): Promise<number> {
    return (await json<{ id: number }>(`${PARABANK_API}/login/john/demo`)).id;
  },
  async accounts(customer: number): Promise<ParabankAccount[]> {
    return json<ParabankAccount[]>(`${PARABANK_API}/customers/${customer}/accounts`);
  },
  async transactions(account: number): Promise<ParabankTransaction[]> {
    return json<ParabankTransaction[]>(`${PARABANK_API}/accounts/${account}/transactions`);
  },
  /** The highest transaction id on the account now, so later ones can be told apart. */
  async mark(account: number): Promise<number> {
    const list = await parabank.transactions(account);
    return list.reduce((max, entry) => Math.max(max, entry.id), 0);
  },
};

/* ---------- OrangeHRM: opensource-demo.orangehrmlive.com, Admin / admin123 ---------- */

export const ORANGEHRM = 'https://opensource-demo.orangehrmlive.com/web/index.php';

/** A signed-in session on the OrangeHRM demo, through its own login form. */
export async function orangehrm() {
  const jar = new Map<string, string>();
  const keep = (response: Response) => {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const at = pair?.indexOf('=') ?? -1;
      if (pair && at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
  };
  const cookie = () => [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
  const page = await fetch(`${ORANGEHRM}/auth/login`, { signal: AbortSignal.timeout(30_000) });
  keep(page);
  const csrf = (await page.text()).match(/:token="&quot;([^&]+)&quot;"/)?.[1];
  if (!csrf) throw new Error('OrangeHRM login page had no form token');
  const login = await fetch(`${ORANGEHRM}/auth/validate`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _token: csrf, username: 'Admin', password: 'admin123' }),
    signal: AbortSignal.timeout(30_000),
  });
  keep(login);
  if (!(login.headers.get('location') ?? '').includes('/dashboard'))
    throw new Error('OrangeHRM demo login was refused');
  const api = <T>(path: string, init: RequestInit = {}) =>
    json<T>(`${ORANGEHRM}/api/v2${path}`, {
      ...init,
      headers: { cookie: cookie(), 'content-type': 'application/json' },
    });
  return {
    async employees(name: string) {
      return api<{ data: { empNumber: number; firstName: string; lastName: string }[] }>(
        `/pim/employees?limit=50&nameOrId=${encodeURIComponent(name)}`,
      );
    },
    async userCount() {
      return (await api<{ meta: { total: number } }>('/admin/users?limit=1')).meta.total;
    },
    async deleteEmployees(ids: number[]) {
      if (ids.length)
        await api('/pim/employees', { method: 'DELETE', body: JSON.stringify({ ids }) });
    },
  };
}

/* ---------- Automation Exercise: automationexercise.com, accounts made per job ---------- */

const AUTOMATION_EXERCISE = 'https://automationexercise.com/api';
export const automationExercise = {
  async exists(email: string, password: string): Promise<boolean> {
    const result = await json<{ responseCode: number }>(`${AUTOMATION_EXERCISE}/verifyLogin`, {
      method: 'POST',
      body: new URLSearchParams({ email, password }),
    });
    return result.responseCode === 200;
  },
  async remove(email: string, password: string) {
    await json(`${AUTOMATION_EXERCISE}/deleteAccount`, {
      method: 'DELETE',
      body: new URLSearchParams({ email, password }),
    });
  },
};

/* ---------- The Internet: the-internet.herokuapp.com ---------- */

export const THE_INTERNET = 'https://the-internet.herokuapp.com';
/** The names of the plain-text files the download page lists now. */
export async function downloadable(): Promise<string[]> {
  const response = await fetch(`${THE_INTERNET}/download`, { signal: AbortSignal.timeout(30_000) });
  const html = await response.text();
  return [...html.matchAll(/href="download\/([^"]+\.txt)"/g)].map((match) =>
    decodeURIComponent(match[1] as string),
  );
}

/* ---------- GitHub: the test account named in the environment ---------- */

export const github = {
  async issues(repo: string, auth: string, title: string) {
    // The list, not search: search is indexed a while after an issue is opened.
    const recent = await json<{ number: number; title: string; state: string }[]>(
      `https://api.github.com/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=50`,
      { headers: { authorization: `Bearer ${auth}`, 'x-github-api-version': '2022-11-28' } },
    );
    return recent.filter((item) => item.title.includes(title));
  },
};

/** Whether a site answers at all; a down site skips its tasks rather than failing them. */
export async function reachable(url: string, tries = 3): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'follow' });
      // A bot check answers 403 but the site is up; the agent meets the check, not an outage.
      if (response.status < 500) return true;
    } catch {
      // A sleeping host can miss the first request; try again.
    }
    if (attempt + 1 < tries) await Bun.sleep(5000);
  }
  return false;
}
