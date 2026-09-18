/**
 * The page. One document, no framework, no build step: the Worker returns this
 * string and the browser has everything it needs.
 *
 * The colours, the two typefaces and the shapes are the product's own, taken
 * from `apps/web/src/design/tokens.css` so the try-it page and the app look
 * like one thing. Light and dark both come from the same tokens, following the
 * system unless someone says otherwise.
 */
import type { Sample } from './samples.ts';

export type PageConfig = {
  /** Where "run this for me" goes. One value, changed in wrangler.toml. */
  landingUrl: string;
  repoUrl: string;
  samples: Sample[];
  maxInputChars: number;
  perIpPerDay: number;
  /** Fresh per request, so the policy can name this page's own two blocks. */
  nonce: string;
};

/**
 * JSON safe to sit inside a script element: with every `<` escaped there is no
 * way for a sample to close the tag it lives in.
 */
const embed = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

const TOKENS = `
:root {
  color-scheme: light;
  --canvas: #f4f3ef;
  --surface: #ffffff;
  --soft: #f8f7f4;
  --text: #2a2d34;
  --heading: #17191d;
  --muted: #6b7080;
  --line: #e7e5df;
  --line-strong: #dbd8d0;
  --hover: #ebe9e3;
  --primary: #2f5fd6;
  --primary-hover: #274fb8;
  --primary-fg: #ffffff;
  --blue-soft: #e4ebfb;
  --blue-ink: #22459c;
  --blue-line: #c2d0f2;
  --sage: #e6efe4;
  --sage-ink: #3d6142;
  --sand: #f5ecdc;
  --sand-ink: #7a5a2a;
  --success: #2e8a5a;
  --danger: #d24b4b;
  --danger-soft: #fbe9e9;
  --chip-bg: #f1efea;
  --shadow: 0 1px 2px #1d1b1608, 0 4px 16px #1d1b1608;
  --elevated: 0 12px 32px #1d1b1614, 0 1px 2px #1d1b160a;
  --ring: #2f5fd640;
  --studio: #0f1113;
  --studio-line: #262a2f;
  --studio-text: #e6e7ea;
  --studio-muted: #8e939c;
  --font-body: "DM Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-head: "Manrope", "DM Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { ${darkTokens()} }
}
:root[data-theme="dark"] { ${darkTokens()} }
`;

function darkTokens(): string {
  return `
    color-scheme: dark;
    --canvas: #0c0c0d;
    --surface: #161719;
    --soft: #202225;
    --text: #d3d5da;
    --heading: #f3f4f6;
    --muted: #8a8f98;
    --line: #2b2e33;
    --line-strong: #3e424a;
    --hover: #1f2023;
    --primary: #8db6f7;
    --primary-hover: #a6c7f9;
    --primary-fg: #0c1524;
    --blue-soft: #1b2942;
    --blue-ink: #b9d1f6;
    --blue-line: #2c4470;
    --sage: #1b2a21;
    --sage-ink: #a9cdb4;
    --sand: #2a2419;
    --sand-ink: #d6c19a;
    --success: #5fc08f;
    --danger: #f28b8b;
    --danger-soft: #33201f;
    --chip-bg: #202225;
    --shadow: 0 8px 24px -8px #000000cc;
    --elevated: 0 24px 48px -12px #000000e6, 0 0 0 1px #42464e;
    --ring: #8db6f780;
  `;
}

const STYLE = `
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--canvas);
  color: var(--text);
  font-family: var(--font-body);
  font-size: 15px;
  line-height: 22px;
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3 { font-family: var(--font-head); color: var(--heading); margin: 0; }
p { margin: 0; }
a { color: var(--primary); text-decoration: none; }
a:hover { text-decoration: underline; }
img { display: block; max-width: 100%; }
:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; border-radius: 6px; }

.wrap { width: 100%; max-width: 720px; margin: 0 auto; padding: 0 16px; }
header { border-bottom: 1px solid var(--line); background: var(--canvas); }
.bar { display: flex; align-items: center; gap: 10px; height: 60px; }
.word { font-family: var(--font-head); font-size: 16px; font-weight: 700; color: var(--heading); }
.grow { flex: 1; }
.ghost {
  display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px;
  border-radius: 8px; border: 1px solid var(--line-strong); background: transparent;
  color: var(--muted); font: inherit; font-size: 13px; cursor: pointer;
}
.ghost:hover { background: var(--hover); color: var(--text); }

.hero { padding: 40px 0 8px; }
h1 { font-size: 34px; line-height: 40px; font-weight: 700; letter-spacing: -.02em; text-wrap: balance; }
.lede { margin-top: 12px; font-size: 16px; line-height: 25px; color: var(--muted); text-wrap: pretty; }

.panel {
  margin-top: 28px; background: var(--surface); border: 1px solid var(--line);
  border-radius: 18px; box-shadow: var(--shadow); overflow: hidden;
}
.panel-pad { padding: 16px; }
textarea {
  width: 100%; min-height: 220px; resize: vertical; border: 0; background: transparent;
  color: var(--text); font: inherit; font-size: 15px; line-height: 23px; padding: 0;
}
textarea:focus { outline: none; }
textarea::placeholder { color: var(--muted); }
.tools {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 12px 16px; border-top: 1px solid var(--line); background: var(--soft);
}
.count { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.count.over { color: var(--danger); }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  height: 40px; padding: 0 18px; border: 0; border-radius: 10px;
  background: var(--primary); color: var(--primary-fg);
  font: inherit; font-size: 15px; font-weight: 600; cursor: pointer;
}
.btn:hover { background: var(--primary-hover); }
.btn[disabled] { opacity: .5; cursor: default; }

.samples { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
.sample {
  flex: 1 1 200px; text-align: left; padding: 10px 12px; border-radius: 12px;
  border: 1px solid var(--line); background: var(--surface); color: var(--text);
  font: inherit; cursor: pointer;
}
.sample:hover { border-color: var(--blue-line); background: var(--blue-soft); }
.sample b { display: block; font-size: 13.5px; font-weight: 600; color: var(--heading); }
.sample span { display: block; font-size: 12px; color: var(--muted); margin-top: 2px; }
.samples-label { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-top: 26px; }

.stages { display: flex; flex-direction: column; gap: 2px; }
.stage { display: flex; align-items: center; gap: 12px; padding: 9px 0; color: var(--muted); font-size: 14px; }
.stage .dot {
  width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--line-strong);
  flex: 0 0 auto; display: grid; place-items: center;
}
.stage.on { color: var(--heading); }
.stage.on .dot { border-color: var(--primary); border-right-color: transparent; animation: spin .9s linear infinite; }
.stage.done .dot { border-color: var(--success); background: var(--success); }
.stage.done .dot::after { content: ""; width: 5px; height: 9px; border: 2px solid var(--surface); border-top: 0; border-left: 0; transform: rotate(45deg) translate(-1px, -1px); }
.stage .when { margin-left: auto; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
@keyframes spin { to { transform: rotate(360deg); } }

.notice {
  display: flex; gap: 10px; align-items: flex-start; padding: 14px 16px; border-radius: 14px;
  background: var(--sand); color: var(--sand-ink); font-size: 14px; line-height: 21px;
}
.notice.hard { background: var(--danger-soft); color: var(--danger); }

.case { margin-top: 24px; }
.case-top {
  display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap;
  padding: 18px 20px; border-bottom: 1px solid var(--line);
}
.who { flex: 1 1 220px; min-width: 0; }
.who .h { margin-bottom: 5px; }
.company { font-family: var(--font-head); font-size: 17px; font-weight: 700; color: var(--heading); }
.issue { font-size: 14px; color: var(--muted); margin-top: 3px; text-wrap: pretty; }
.pill {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px;
  border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap;
}
.pill.high { background: var(--sage); color: var(--sage-ink); }
.pill.medium { background: var(--sand); color: var(--sand-ink); }
.pill.low { background: var(--chip-bg); color: var(--muted); }

.amount { padding: 22px 20px 18px; border-bottom: 1px solid var(--line); }
.amount .figure {
  font-family: var(--font-head); font-size: 46px; line-height: 50px; font-weight: 700;
  letter-spacing: -.03em; color: var(--heading); font-variant-numeric: tabular-nums;
}
.amount .figure.words { font-size: 22px; line-height: 30px; letter-spacing: -.01em; text-wrap: pretty; }
.amount .summary { margin-top: 8px; font-size: 15px; line-height: 23px; color: var(--text); text-wrap: pretty; }
.amount .odds-why { margin-top: 10px; font-size: 13px; color: var(--muted); }
.amount .caveat {
  margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line);
  font-size: 12px; line-height: 18px; color: var(--muted);
}

section.block { padding: 18px 20px; border-bottom: 1px solid var(--line); }
section.block:last-child { border-bottom: 0; }
.h { font-size: 11px; letter-spacing: .09em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
.list { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }

.basis { display: flex; flex-direction: column; gap: 5px; }
.basis .claim { font-size: 14.5px; line-height: 22px; color: var(--text); }
.src { font-size: 12.5px; color: var(--muted); }
.src a { word-break: break-word; }
.src.verbatim { margin-top: 10px; }
.srcq { border-left: 2px solid var(--blue-line); padding-left: 10px; color: var(--muted); font-size: 13px; }

blockquote {
  margin: 0; padding: 10px 0 10px 14px; border-left: 3px solid var(--blue-line);
  background: var(--blue-soft); border-radius: 0 10px 10px 0; padding-right: 12px;
}
blockquote q {
  font-size: 14.5px; line-height: 23px; color: var(--blue-ink);
  quotes: "\\201C" "\\201D" "\\2018" "\\2019";
}
blockquote .why { display: block; margin-top: 5px; font-size: 12px; color: var(--muted); }

.msg { margin-top: 12px; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.msg .subject {
  padding: 10px 14px; border-bottom: 1px solid var(--line); background: var(--soft);
  font-size: 14px; font-weight: 600; color: var(--heading);
}
.msg .body { padding: 14px; font-size: 14.5px; line-height: 23px; white-space: pre-wrap; text-wrap: pretty; }
.msg .foot { display: flex; gap: 8px; align-items: center; padding: 10px 14px; border-top: 1px solid var(--line); background: var(--soft); }

.ladder { margin-top: 14px; display: flex; flex-direction: column; }
.rung { display: flex; gap: 14px; }
.rail { display: flex; flex-direction: column; align-items: center; flex: 0 0 auto; width: 10px; }
.rail .pip { width: 10px; height: 10px; border-radius: 50%; background: var(--blue-line); margin-top: 6px; flex: 0 0 auto; }
.rung:first-child .rail .pip { background: var(--primary); }
.rail .line { flex: 1; width: 2px; background: var(--line-strong); }
.rung:last-child .rail .line { display: none; }
.rung .text { padding-bottom: 16px; }
.rung:last-child .text { padding-bottom: 0; }
.rung .day { font-size: 12px; font-weight: 600; color: var(--muted); letter-spacing: .02em; }
.rung .what { font-size: 14.5px; line-height: 22px; margin-top: 1px; text-wrap: pretty; }

.next {
  display: flex; gap: 14px; align-items: center; flex-wrap: wrap;
  padding: 14px 20px; background: var(--soft); border-top: 1px solid var(--line);
  font-size: 14px; line-height: 22px; color: var(--muted);
}
.next span { flex: 1 1 320px; text-wrap: pretty; }
.acts { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 12px; }

.cta {
  margin: 24px 0 8px; padding: 22px 20px; border-radius: 18px;
  background: var(--studio); border: 1px solid var(--studio-line); color: var(--studio-text);
  background-image: radial-gradient(ellipse at 50% 0%, #2f5fd626, transparent 60%);
}
.cta h2 { font-size: 20px; line-height: 27px; font-weight: 700; color: var(--studio-text); text-wrap: balance; }
.cta p { margin-top: 8px; font-size: 14.5px; line-height: 22px; color: var(--studio-muted); text-wrap: pretty; }
.cta .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
.cta .go { background: var(--primary); color: #fff; }
.cta .go:hover { background: var(--primary-hover); text-decoration: none; }
.cta .alt { border: 1px solid var(--studio-line); color: var(--studio-text); background: transparent; }
.cta .alt:hover { background: #ffffff10; text-decoration: none; }
.cta a.btn:hover { text-decoration: none; }

footer { padding: 28px 0 48px; font-size: 12.5px; color: var(--muted); }
footer p + p { margin-top: 6px; }

.hidden { display: none !important; }
.spacer { height: 8px; }
/* The page sets no inline styles, so the policy can forbid them outright. */
.offscreen { position: fixed; top: -1000px; }

@media (max-width: 600px) {
  h1 { font-size: 27px; line-height: 33px; }
  .hero { padding: 28px 0 4px; }
  .amount .figure { font-size: 38px; line-height: 42px; }
  .case-top, .amount, section.block, .next { padding-left: 16px; padding-right: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .stage.on .dot { animation: none; }
}
`;

/** Written without template literals so it can sit inside one. */
const SCRIPT = String.raw`
(function () {
  var config = JSON.parse(document.getElementById('config').textContent);
  var box = document.getElementById('paste');
  var count = document.getElementById('count');
  var go = document.getElementById('go');
  var samples = document.getElementById('samples');
  var progress = document.getElementById('progress');
  var problem = document.getElementById('problem');
  var out = document.getElementById('out');
  var theme = document.getElementById('theme');
  var running = false;
  var timer = null;
  var startedAt = 0;

  /* ---------- theme ---------- */
  function readTheme() { try { return localStorage.getItem('melete-theme'); } catch (e) { return null; } }
  function applyTheme(value) {
    if (value) document.documentElement.setAttribute('data-theme', value);
    else document.documentElement.removeAttribute('data-theme');
  }
  applyTheme(readTheme());
  theme.addEventListener('click', function () {
    var dark = document.documentElement.getAttribute('data-theme');
    if (!dark) dark = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    var next = dark === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('melete-theme', next); } catch (e) {}
  });

  /* ---------- the box ---------- */
  function tally() {
    var n = box.value.length;
    count.textContent = n.toLocaleString() + ' / ' + config.maxInputChars.toLocaleString();
    count.className = n > config.maxInputChars ? 'count over' : 'count';
    go.disabled = running || n < 40 || n > config.maxInputChars;
  }
  box.addEventListener('input', tally);

  for (var i = 0; i < config.samples.length; i++) {
    (function (sample) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'sample';
      var title = document.createElement('b');
      title.textContent = sample.label;
      var hint = document.createElement('span');
      hint.textContent = sample.hint;
      button.appendChild(title);
      button.appendChild(hint);
      button.addEventListener('click', function () {
        box.value = sample.text;
        tally();
        box.focus();
        box.setSelectionRange(0, 0);
        box.scrollTop = 0;
      });
      samples.appendChild(button);
    })(config.samples[i]);
  }

  /* ---------- stages ---------- */
  var STAGES = [
    ['reading', 'Reading what you pasted'],
    ['model', 'Working out what you are owed'],
    ['checking', 'Checking every quote against your own words']
  ];

  function drawStages(at, searches) {
    var html = '';
    for (var i = 0; i < STAGES.length; i++) {
      var cls = i < at ? 'stage done' : i === at ? 'stage on' : 'stage';
      var label = STAGES[i][1];
      if (i === 2 && searches > 0) label += ' · ' + searches + (searches === 1 ? ' page read' : ' pages read');
      html += '<div class="' + cls + '"><span class="dot"></span><span>' + esc(label) + '</span>' +
        (i === at ? '<span class="when" id="elapsed"></span>' : '') + '</div>';
    }
    progress.innerHTML = '<div class="panel-pad stages">' + html + '</div>';
  }

  function tick() {
    var el = document.getElementById('elapsed');
    if (!el) return;
    var s = Math.round((Date.now() - startedAt) / 1000);
    el.textContent = s + 's';
  }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- run ---------- */
  go.addEventListener('click', function () { run(); });
  box.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') run();
  });

  function reset() {
    problem.className = 'hidden';
    problem.innerHTML = '';
    out.className = 'hidden';
    out.innerHTML = '';
  }

  function run() {
    if (running) return;
    var text = box.value;
    if (text.trim().length < 40 || text.length > config.maxInputChars) return;
    running = true;
    go.disabled = true;
    go.textContent = 'Working…';
    reset();
    progress.className = 'panel';
    startedAt = Date.now();
    drawStages(0, 0);
    timer = setInterval(tick, 1000);
    tick();
    progress.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    fetch('/api/case-file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: text })
    }).then(function (response) {
      if (response.headers.get('content-type') && response.headers.get('content-type').indexOf('ndjson') >= 0) {
        return readLines(response);
      }
      return response.json().then(function (body) { finish(body); });
    }).catch(function () {
      finish({ ok: false, code: 'upstream', message: 'The connection dropped. Try again.' });
    });
  }

  function readLines(response) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var searches = 0;
    function pump() {
      return reader.read().then(function (chunk) {
        buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
        var lines = buffer.split('\n');
        buffer = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          var value;
          try { value = JSON.parse(lines[i]); } catch (e) { continue; }
          if (value.ok === true || value.ok === false) { finish(value); return; }
          if (value.stage === 'reading') drawStages(0, searches);
          else if (value.stage === 'model') drawStages(1, searches);
          else if (value.stage === 'checking') { searches = value.searches || 0; drawStages(2, searches); }
          tick();
        }
        if (chunk.done) { finish({ ok: false, code: 'upstream', message: 'That stopped before it finished. Try again.' }); return; }
        return pump();
      });
    }
    return pump();
  }

  function finish(body) {
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
    progress.className = 'hidden';
    progress.innerHTML = '';
    go.textContent = 'Build the case file';
    tally();
    if (body && body.ok) render(body.caseFile, body.meta);
    else showProblem(body || {});
  }

  /* Every ending says what happened and what to do next. Out of turns is not
     an error, so it gets the thing a person would want instead. */
  var RETRY = { timeout: 1, upstream: 1, malformed: 1, bad_request: 1, refused: 1 };

  function showProblem(body) {
    var code = body.code || 'upstream';
    var spent = code === 'rate_limited' || code === 'busy';
    problem.className = 'panel panel-pad';
    var h = '<div class="notice"><span>' +
      esc(body.message || 'Something went wrong. Try again.') + '</span></div>';
    if (RETRY[code]) {
      h += '<div class="acts"><button type="button" class="ghost" id="again">Try again</button>';
      if (code === 'timeout') h += '<span class="count">A shorter paste finishes sooner.</span>';
      h += '</div>';
    }
    problem.innerHTML = h;
    if (spent) document.getElementById('cta').className = '';
    var again = document.getElementById('again');
    if (again) again.addEventListener('click', function () { reset(); run(); });
    problem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* ---------- the card ---------- */
  /* narrowSymbol so a pound is a pound to a reader anywhere, not "GBP" or "US$". */
  function money(minor, currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency', currency: currency, currencyDisplay: 'narrowSymbol'
      }).format(minor / 100);
    } catch (e) {
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency }).format(minor / 100);
      } catch (e2) {
        return (minor / 100).toFixed(2) + ' ' + currency;
      }
    }
  }

  function dayLabel(offset) {
    if (offset === 0) return 'Today';
    var date = new Date();
    date.setDate(date.getDate() + offset);
    var shown = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return shown + ' · day ' + offset;
  }

  function host(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; }
  }

  function stamp() {
    try {
      return new Date().toLocaleDateString(undefined, {
        day: 'numeric', month: 'long', year: 'numeric'
      });
    } catch (e) { return new Date().toDateString(); }
  }

  /* The server has already checked all of this, and every value below still
     goes through esc() or a whitelist before it reaches the document: the one
     place model text could ever become markup is here, so it is closed here. */
  function render(file, meta) {
    var h = '';
    var WORDS = { high: 'Good odds', medium: 'Fair odds', low: 'Long shot' };
    /* hasOwn, not truthiness: constructor and toString are truthy on any
       object literal, and this value becomes a class name. */
    var level = Object.prototype.hasOwnProperty.call(WORDS, file.odds.level)
      ? file.odds.level : 'low';
    var days = Math.max(1, Math.round(Number(file.odds.expectedDays) || 1));

    h += '<div class="case-top">';
    h += '<div class="who">';
    h += '<div class="h">Case file · ' + esc(stamp()) + '</div>';
    h += '<div class="company">' + esc(file.company) + '</div>';
    h += '<div class="issue">' + esc(file.issue) + '</div>';
    h += '</div>';
    h += '<span class="pill ' + level + '">' + WORDS[level] + ' · about ' + days + ' days</span>';
    h += '</div>';

    h += '<div class="amount">';
    if (file.entitlement.amountMinor !== null && file.entitlement.currency) {
      h += '<div class="figure">' + esc(money(file.entitlement.amountMinor, file.entitlement.currency)) + '</div>';
      h += '<div class="summary">' + esc(file.entitlement.summary) + '</div>';
    } else {
      h += '<div class="figure words">' + esc(file.entitlement.summary) + '</div>';
    }
    h += '<div class="odds-why">' + esc(file.odds.why) + '</div>';
    /* The card is what gets screenshotted and passed around, so the line that
       says what this is travels with it instead of sitting in a page footer
       below the fold, where the figure and the odds pill go without it. */
    h += '<div class="caveat">Melete writes the message. You read it and send it yourself. ' +
      'This is not legal advice.</div>';
    h += '</div>';

    if (file.entitlement.basis.length) {
      /* Not "why you are owed it": nothing here has adjudicated anything, and
         after a refusal that heading would be plainly untrue. */
      h += '<section class="block"><div class="h">What this rests on</div><div class="list">';
      for (var b = 0; b < file.entitlement.basis.length; b++) {
        var item = file.entitlement.basis[b];
        h += '<div class="basis"><div class="claim">' + esc(item.claim) + '</div>';
        if (item.source.kind === 'quote' && item.source.alsoEvidence) {
          h += '<div class="src">In their own words, quoted below.</div>';
        } else if (item.source.kind === 'quote') {
          h += '<div class="srcq">“' + esc(item.source.quote) + '”</div>';
        } else if (/^https?:\/\//i.test(item.source.url)) {
          h += '<div class="src">Their own page: <a href="' + esc(item.source.url) +
            '" target="_blank" rel="noopener noreferrer nofollow">' +
            esc(item.source.title || host(item.source.url)) + '</a></div>';
        }
        h += '</div>';
      }
      h += '</div></section>';
    }

    h += '<section class="block"><div class="h">What proves it</div>';
    if (file.evidence.length) {
      h += '<div class="list">';
      for (var e = 0; e < file.evidence.length; e++) {
        h += '<blockquote><q>' + esc(file.evidence[e].quote) + '</q><span class="why">' + esc(file.evidence[e].why) + '</span></blockquote>';
      }
      h += '</div>';
      h +=
        '<div class="src verbatim">Every sentence above is word for word from what you pasted.</div>';
    } else {
      h += '<div class="list"><div class="notice"><span>' + esc(file.noEvidenceNote || '') + '</span></div></div>';
    }
    h += '</section>';

    h += '<section class="block"><div class="h">The message to send</div>';
    h += '<div class="msg">';
    h += '<div class="subject">' + esc(file.message.subject) + '</div>';
    h += '<div class="body" id="msgbody">' + esc(file.message.body) + '</div>';
    h += '<div class="foot"><button type="button" class="ghost" id="copy">Copy the message</button>' +
      '<span class="count" id="copied"></span></div>';
    h += '</div></section>';

    h += '<section class="block"><div class="h">If they go quiet</div><div class="ladder">';
    for (var s = 0; s < file.ladder.length; s++) {
      h += '<div class="rung"><div class="rail"><span class="pip"></span><span class="line"></span></div>' +
        '<div class="text"><div class="day">' + esc(dayLabel(file.ladder[s].dayOffset)) + '</div>' +
        '<div class="what">' + esc(file.ladder[s].step) + '</div></div></div>';
    }
    h += '</div></section>';

    h += '<div class="next"><span>' + esc(file.meleteNext) + '</span>' +
      '<button type="button" class="ghost" id="restart">Start again</button></div>';

    out.className = 'panel case';
    out.innerHTML = h;

    var copy = document.getElementById('copy');
    copy.addEventListener('click', function () {
      var said = document.getElementById('copied');
      var body = file.message.subject + '\n\n' + file.message.body;
      var done = function () { said.textContent = 'Copied'; setTimeout(function () { said.textContent = ''; }, 2500); };
      try {
        navigator.clipboard.writeText(body).then(done, function () { legacy(body, done); });
      } catch (err) { legacy(body, done); }
    });

    document.getElementById('restart').addEventListener('click', function () {
      reset();
      box.value = '';
      tally();
      box.focus();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    document.getElementById('cta').className = '';
    out.scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (meta && window.console && console.debug) console.debug('case file in ' + meta.ms + 'ms');
  }

  function legacy(text, done) {
    var field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.className = 'offscreen';
    document.body.appendChild(field);
    field.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    document.body.removeChild(field);
  }

  tally();
})();
`;

export function page(config: PageConfig): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Melete · Deals with every company in your life</title>
<meta name="description" content="Paste an email from a company and get a case file: what you are owed and why, the sentence that proves it, the message to send, and what to do if they go quiet." />
<meta name="color-scheme" content="light dark" />
<meta property="og:title" content="Melete · Deals with every company in your life, so you don't" />
<meta property="og:description" content="Paste an email from a company. Get the case file: what you are owed, the sentence that proves it, and the message to send." />
<meta property="og:type" content="website" />
<link rel="icon" href="/melete-logo.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=Manrope:wght@600;700&display=swap" />
<style nonce="${config.nonce}">${TOKENS}${STYLE}</style>
</head>
<body>
<header>
  <div class="wrap bar">
    <img src="/melete-logo.png" alt="" width="40" height="17" />
    <span class="word">Melete</span>
    <span class="grow"></span>
    <button type="button" class="ghost" id="theme" aria-label="Switch between light and dark">Light / dark</button>
  </div>
</header>

<main class="wrap">
  <div class="hero">
    <h1>Deals with every company in your life, so you don&rsquo;t</h1>
    <p class="lede">
      Paste an email from a company, or write what happened. You get a case file: what you are
      owed and why, the sentence that proves it, the message to send, and what to do if they
      go quiet. No account, nothing kept.
    </p>
  </div>

  <div class="panel">
    <div class="panel-pad">
      <label for="paste" class="h">The email, or what happened</label>
      <div class="spacer"></div>
      <textarea id="paste" spellcheck="false"
        placeholder="Paste the whole email &mdash; headers, footer and all &mdash; or just tell it what happened and what they promised."></textarea>
    </div>
    <div class="tools">
      <button type="button" class="btn" id="go">Build the case file</button>
      <span class="grow"></span>
      <span class="count" id="count"></span>
    </div>
  </div>

  <div class="samples-label">Or try one of these</div>
  <div class="samples" id="samples"></div>

  <div id="progress" class="hidden" aria-live="polite"></div>
  <div id="problem" class="hidden" role="status"></div>
  <div id="out" class="hidden"></div>

  <div id="cta" class="hidden">
    <div class="cta">
      <h2>Want Melete to run this for you, and find every other one in your inbox?</h2>
      <p>
        Connect an inbox and Melete maps every company in your life: what you pay, what you are
        owed, what renews next. Then it handles them, over days, asking you once. Open source.
      </p>
      <div class="row">
        <a class="btn go" href="${escapeAttribute(config.landingUrl)}">See how it works</a>
        <a class="btn alt" href="${escapeAttribute(config.repoUrl)}" target="_blank" rel="noopener">Read the code</a>
      </div>
    </div>
  </div>

  <footer>
    <p>Nothing you paste is stored, and it is never used to train anything. It goes to the model once, and the case file comes back.</p>
    <p>Melete writes the message. You read it and send it yourself. It is not legal advice.</p>
    <p>${config.perIpPerDay} case files a day per connection, so everyone gets a turn.</p>
  </footer>
</main>

<script type="application/json" id="config" nonce="${config.nonce}">${embed({
    samples: config.samples,
    maxInputChars: config.maxInputChars,
  })}</script>
<script nonce="${config.nonce}">${SCRIPT}</script>
</body>
</html>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
