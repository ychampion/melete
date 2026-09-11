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
    port: 3130,
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
    url: 'http://127.0.0.1:3130',
    close: () => server.stop(true),
  };
}
