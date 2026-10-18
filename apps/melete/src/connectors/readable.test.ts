import { expect, test } from 'bun:test';
import { decodeEntities, readableText, tagEnd } from './readable.ts';

/**
 * Numbers in [0, 1) from a 32-bit generator (mulberry32) that does not repeat
 * for 2^32 draws. A product past 2^53 loses its low bits, so the usual
 * `seed * 1103515245 % 2 ** 31` falls into a cycle of about 10,000 draws.
 */
function generator(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

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

test('a stray quote in a tag does not hide the rows after it', () => {
  // A meetings calendar whose rows each carry a stray quote before `>`, as a
  // real one does. Read as an open value, the quote swallowed every other row,
  // and an agent said the next meeting was the one after the one it never saw.
  const row = (month: string, days: string, shaded: boolean) =>
    `<div class="${shaded ? 'meeting--shaded ' : ''}row meeting" "><div class="meeting__month"><strong>${month}</strong></div><div class="meeting__date">${days}</div><div class="col"><strong>Statement:</strong><br><a href="/statements/${month.toLowerCase()}.htm">HTML</a></div></div>`;
  const html = `<h4>2026 meetings</h4>${row('January', '27-28', false)}${row('March', '17-18*', true)}${row('April', '28-29', false)}${row('June', '16-17*', true)}${row('October', '27-28', false)}${row('December', '8-9*', true)}<p>* With projections.</p>`;
  const text = readableText(html, 'https://example.org/calendar').text;
  for (const [month, days] of [
    ['January', '27-28'] as const,
    ['March', '17-18*'],
    ['April', '28-29'],
    ['June', '16-17*'],
    ['October', '27-28'],
    ['December', '8-9*'],
  ])
    expect(text).toMatch(new RegExp(`${month}\\s+${days.replace('*', '\\*')}`));
  expect(text).toContain('[HTML](https://example.org/statements/october.htm)');
  expect(text).toContain('* With projections.');
  expect(text).not.toContain('class=');
});

test('a tag ends where a browser ends it, whatever stray quotes it holds', () => {
  const cases: Array<[string, number]> = [
    ['<div class="a" ">after', 16],
    ['<div class="a"">after', 15],
    ["<div class='a' '>after", 16],
    ['<div "class=a>after', 13],
    ['<div data-x=">">after', 15],
    ["<div data-x='>'>after", 15],
    ['<div data-x = " > ">after', 19],
    ['<div x=a"b>after', 10],
    ['<div ="x">after', 9],
    ['<br/>after', 4],
    ['<img src="a" / alt=">">after', 22],
    ['</div ">after', 7],
    ['<div class="never closed>', -1],
  ];
  for (const [html, end] of cases) expect([html, tagEnd(html, 0)]).toEqual([html, end]);
  // Built from the grammar a browser reads, so where each tag ends is known:
  // names may hold stray quotes, values in quotes may hold `>` and the other quote.
  const random = generator(11);
  const pick = (from: string, length: number) =>
    Array.from({ length }, () => from[Math.floor(random() * from.length)]).join('');
  for (let round = 0; round < 5_000; round += 1) {
    let tag = `<${random() < 0.2 ? '/' : ''}${pick('abcdiv', 1 + Math.floor(random() * 5))}`;
    const count = Math.floor(random() * 5);
    for (let at = 0; at < count; at += 1) {
      const space = pick(' \t\n', 1 + Math.floor(random() * 2));
      const name = pick(`abc-"'<`, 1 + Math.floor(random() * 4));
      const kind = random();
      const around = random() < 0.5 ? '' : ' ';
      if (kind < 0.25) tag += `${space}${name}`;
      // An unquoted value may hold quotes, but not start with one.
      else if (kind < 0.5)
        tag += `${space}${name}${around}=${around}${pick('abc<=`', 1)}${pick(`abc"'<=\``, Math.floor(random() * 4))}`;
      else if (kind < 0.75)
        tag += `${space}${name}${around}=${around}"${pick(`ab >'=/\n`, Math.floor(random() * 5))}"`;
      else
        tag += `${space}${name}${around}=${around}'${pick(`ab >"=/\n`, Math.floor(random() * 5))}'`;
      // A quoted value may be followed straight away by another quote or a slash.
      if (kind >= 0.5 && random() < 0.2) tag += pick(`"'/`, 1);
    }
    tag += random() < 0.3 ? ' /' : '';
    const html = `${tag}>TAIL" > '`;
    expect([html, tagEnd(html, 0)]).toEqual([html, tag.length]);
  }
});

test('comments and declarations end where a browser ends them', () => {
  const cases: Array<[string, string]> = [
    // `<!-->` and `<!--->` are whole, empty comments.
    ['<p>one</p><!--><p>two</p>', 'one\n\ntwo'],
    ['<p>one</p><!---><p>two</p>', 'one\n\ntwo'],
    ['<p>one</p><!-- note --!><p>two</p>', 'one\n\ntwo'],
    ['<p>one</p><!-- a -- b ----><p>two</p>', 'one\n\ntwo'],
    // The dashes of `<!--` close only before `>`: `<!--!>` stays open.
    ['<p>one</p><!--!><p>HIDDEN</p>', 'one'],
    // `</` without a name opens a bogus comment that ends at the next `>`.
    ['<p>a</ junk>b</>c</p>', 'abc'],
    ['<p>a<?xml version="1.0"?>b<![CDATA[ c ]]>d<!doctype html>e</p>', 'abde'],
    ['<p>a </', 'a </'],
  ];
  for (const [html, text] of cases) expect([html, readableText(html).text]).toEqual([html, text]);
});

test('script contents stay out, including scripts written inside one', () => {
  const cases = [
    // How old pages loaded a script: the inner `</script>` does not end the outer one.
    `<script><!--\ndocument.write('<script src="a.js"></script>'); LEAK_ONE\n//--></script><p>after</p>`,
    '<script><!--<script>x</script>LEAK_TWO</script><p>after</p>',
    '<SCRIPT><!--<SCRIPT >x</SCRIPT\t>LEAK_THREE</SCRIPT><p>after</p>',
    // A space that is not a tag space (here a no-break space) does not end the name.
    '<script>x</script >LEAK_FOUR</script><p>after</p>',
    '<style>x</style >LEAK_FIVE</style><p>after</p>',
  ];
  for (const html of cases) expect([html, readableText(html).text]).toEqual([html, 'after']);
  // `-->` undoes the nesting, so the next `</script>` ends the script again.
  expect(readableText('<script><!--<script>--></script><p>after</p>').text).toBe('after');
  expect(readableText('<script><!--></script><p>after</p>').text).toBe('after');
});

test('an embed has no contents, so the page after it is read', () => {
  expect(
    readableText('<p>before</p><embed src="a.pdf" type="application/pdf"><p>after</p>').text,
  ).toBe('before\n\nafter');
});

test('a dotted capital I does not move where scripts and titles end', () => {
  // A full lower-casing turns `İ` into two characters and shifts every position
  // after it, so a page in Turkish lost text and showed parts of its markup.
  const words = 'İSTANBUL İZMİR '.repeat(40);
  const page = readableText(
    `<title>İstanbul - Vikipedi</title><p>${words}</p><script>SCRIPT_SECRET</script><p>after the script</p>`,
  );
  expect(page.title).toBe('İstanbul - Vikipedi');
  expect(page.text).toBe(`${words.trim()}\n\nafter the script`);
});

test('a second title is not read as text', () => {
  const page = readableText('<title>Page</title><p>one</p><title>HIDDEN</title><p>two</p>');
  expect(page.title).toBe('Page');
  expect(page.text).toBe('one\n\ntwo');
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
    `<script><!--${'<script '.repeat(200_000)}`,
    `<script>${'<!--<script>-->'.repeat(100_000)}`,
    '<!--->'.repeat(200_000),
    '<!-- --!'.repeat(200_000),
    '</ '.repeat(300_000),
    'İ<script>x</script>'.repeat(50_000),
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
  const random = generator(7);
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
