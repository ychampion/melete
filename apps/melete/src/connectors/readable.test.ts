import { expect, test } from 'bun:test';
import { decodeEntities, readableText } from './readable.ts';

const PAGE = `<!doctype html>
<html><head>
  <title>Example &amp; Co &mdash; News</title>
  <meta charset="utf-8"><link rel="stylesheet" href="/a.css">
  <style>body { color: red } .secret-style { }</style>
  <script>window.stolen = "SCRIPT_SECRET";</script>
  <script type="application/ld+json">{"x": "JSON_LD_SECRET"}</script>
</head>
<body onload="evil()">
  <noscript>NOSCRIPT_SECRET</noscript>
  <template><p>TEMPLATE_SECRET</p></template>
  <svg><text>SVG_SECRET</text><script>SVG_SCRIPT_SECRET</script></svg>
  <iframe src="https://ads.example/">IFRAME_SECRET</iframe>
  <!-- COMMENT_SECRET <script>nested</script> -->
  <h1>Today&#39;s headlines</h1>
  <p>First <b>story</b> &lt;here&gt; &#x2014; with&nbsp;details.</p>
  <ul><li><a href="/world/1" onclick="steal()">World news</a></li>
      <li><a href="javascript:alert(1)">Bad link</a></li>
      <li><a href="https://user:pw@example.org/x">Credential link</a></li></ul>
  <img src="x.png" alt="A chart of rainfall">
  <form action="/login"><input name="password"><button>BUTTON_SECRET</button><textarea>TEXTAREA_SECRET</textarea></form>
  <table><tr><td>Cell A</td><td>Cell B</td></tr></table>
</body></html>`;

test('a page reads as its words and links, with scripts, styles and hidden content gone', () => {
  const page = readableText(PAGE, 'https://example.com/today');
  expect(page.title).toBe('Example & Co — News');
  for (const hidden of [
    'SCRIPT_SECRET',
    'JSON_LD_SECRET',
    'NOSCRIPT_SECRET',
    'TEMPLATE_SECRET',
    'SVG_SECRET',
    'SVG_SCRIPT_SECRET',
    'IFRAME_SECRET',
    'COMMENT_SECRET',
    'BUTTON_SECRET',
    'TEXTAREA_SECRET',
    'color: red',
    'evil()',
    'steal()',
  ])
    expect(page.text).not.toContain(hidden);
  expect(page.text).not.toMatch(/<\/?(?:script|style|p|a|b|li|ul|div|img|h1|form)\b/i);
  expect(page.text).toContain("Today's headlines");
  expect(page.text).toContain('First story <here> — with details.');
  expect(page.text).toContain('[World news](https://example.com/world/1)');
  // A link that is not a plain web address keeps its words and loses its target.
  expect(page.text).toContain('Bad link');
  expect(page.text).not.toContain('javascript:');
  expect(page.text).not.toContain('user:pw');
  expect(page.text).toContain('A chart of rainfall');
  expect(page.text).toContain('Cell A Cell B');
  expect(page.text.split('\n').length).toBeGreaterThan(4);
});

test('markup tricks do not bring script contents back', () => {
  const cases: Array<[string, string]> = [
    ['<SCRIPT>UPPER_SECRET</SCRIPT>after', 'UPPER_SECRET'],
    ['<script src="a.js"/>SELF_CLOSED<p>after</p>', ''],
    ['<script data-x=">">QUOTED_GT_SECRET</script>after', 'QUOTED_GT_SECRET'],
    ["<script data-x='>'>SINGLE_QUOTED_SECRET</script>after", 'SINGLE_QUOTED_SECRET'],
    ['<script>UNCLOSED_SECRET', 'UNCLOSED_SECRET'],
    ['<style>UNCLOSED_STYLE_SECRET', 'UNCLOSED_STYLE_SECRET'],
    ['<script >SPACED_SECRET</script >after', 'SPACED_SECRET'],
    ['<script>a</scriptx>STILL_SCRIPT_SECRET</script>after', 'STILL_SCRIPT_SECRET'],
    ['<!-- <p>COMMENTED_SECRET</p>', 'COMMENTED_SECRET'],
  ];
  for (const [html, secret] of cases) {
    const text = readableText(html).text;
    if (secret) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/<\/?script/i);
  }
  expect(readableText('<p>a < b and c > d</p>').text).toBe('a < b and c > d');
  expect(readableText('<script src="a.js"/>SELF_CLOSED').text).toBe('SELF_CLOSED');
});

test('entities decode once, and out-of-range references are dropped', () => {
  expect(decodeEntities('&amp;lt; &#65;&#x42; &unknown; &#0; &#xD800; &#x110000;')).toBe(
    '&lt; AB &unknown;   ',
  );
});

test('reading is linear in the size of the page, whatever the markup', () => {
  const hostile = [
    '<script'.repeat(200_000),
    '<a href="'.repeat(100_000),
    '<!--'.repeat(200_000),
    `<p title="${'x'.repeat(500_000)}`,
    '<'.repeat(1_000_000),
    `${'<div>'.repeat(100_000)}${'</div>'.repeat(100_000)}`,
    `<a href="/x">${'<a href="/y">'.repeat(50_000)}`,
  ];
  for (const html of hostile) {
    const started = performance.now();
    readableText(html, 'https://example.com/');
    expect(performance.now() - started).toBeLessThan(2_000);
  }
});

test('random tag soup never throws and never leaks a planted script', () => {
  const pieces = [
    '<',
    '>',
    '/',
    '"',
    "'",
    '=',
    '!',
    '-',
    ' ',
    'a',
    'p',
    'script',
    'style',
    '<script>',
    '</script>',
    '<p>',
    '</p>',
    '<a href="/z">',
    '</a>',
    '&amp;',
    '&#',
    ';',
    'text',
    '\n',
  ];
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let round = 0; round < 3_000; round += 1) {
    let soup = '';
    const length = Math.floor(random() * 40);
    for (let index = 0; index < length; index += 1)
      soup += pieces[Math.floor(random() * pieces.length)];
    // A well-formed script planted in the middle of arbitrary text stays out,
    // unless the soup before it opened a comment, a quote or a skipped element
    // that swallows it, in which case it is gone all the same.
    const planted = `${soup}<p>ok</p><script>PLANTED_${round}</script><p>end</p>`;
    const page = readableText(planted, 'https://example.com/');
    expect(page.text).not.toContain(`PLANTED_${round}`);
  }
});
