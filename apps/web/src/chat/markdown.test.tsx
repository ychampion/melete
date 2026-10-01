/**
 * Answers are drawn from their Markdown: code, lists, headings, tables, quotes
 * and links each get their own element, and nothing in a reply ever becomes
 * markup of its own. A link opens only when it points at the web or an email.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { inlineMarks, parseMarkdown, safeHref } from '../experience/markdown.ts';
import { Markdown } from './Markdown.tsx';

const html = (text: string, streaming = false) =>
  renderToStaticMarkup(<Markdown text={text} streaming={streaming} />);

test('a fenced block keeps its text exactly, in a code block with a copy button', () => {
  const blocks = parseMarkdown('Here:\n\n```python\ndef f():\n    return 1\n```\n\nDone.');
  expect(blocks).toEqual([
    { type: 'paragraph', lines: ['Here:'] },
    { type: 'code', lang: 'python', text: 'def f():\n    return 1', terminal: false, open: false },
    { type: 'paragraph', lines: ['Done.'] },
  ]);
  const out = html('```python\ndef f():\n    return 1\n```');
  expect(out).toContain('<pre tabindex="0"><code>def f():\n    return 1</code></pre>');
  expect(out).toContain('aria-label="Copy code"');
  expect(out).toContain('<span>python</span>');
});

test('shell output is a terminal block, and an unclosed fence while streaming stays code', () => {
  const [block] = parseMarkdown('```console\n$ uname\nLinux\n```');
  expect(block).toMatchObject({ type: 'code', terminal: true, text: '$ uname\nLinux' });
  expect(html('```bash\nls')).toContain('data-terminal="true"');
  const [open] = parseMarkdown('```\nhalf a line');
  expect(open).toMatchObject({ type: 'code', open: true, text: 'half a line' });
});

test('art and spacing inside a block survive', () => {
  const cow = ' ______\n< moo >\n ------\n        \\   ^__^\n         \\  (oo)\\_______';
  const [block] = parseMarkdown(`\`\`\`\n${cow}\n\`\`\``);
  expect(block).toMatchObject({ type: 'code', text: cow });
});

test('headings, rules and paragraphs', () => {
  expect(parseMarkdown('# Plan\n## Day one\n#### Small\ntext\n\n---\n\nend')).toEqual([
    { type: 'heading', level: 1, text: 'Plan' },
    { type: 'heading', level: 2, text: 'Day one' },
    { type: 'heading', level: 3, text: 'Small' },
    { type: 'paragraph', lines: ['text'] },
    { type: 'rule' },
    { type: 'paragraph', lines: ['end'] },
  ]);
});

test('bullet, numbered, nested and task lists', () => {
  const [list] = parseMarkdown('- one\n- two\n  - two a\n  - two b\n- three');
  expect(list).toMatchObject({
    type: 'list',
    ordered: false,
    items: [
      { text: 'one', children: [] },
      {
        text: 'two',
        children: [{ type: 'list', items: [{ text: 'two a' }, { text: 'two b' }] }],
      },
      { text: 'three' },
    ],
  });
  const [numbered] = parseMarkdown('3. Pack\n4. Leave');
  expect(numbered).toMatchObject({ type: 'list', ordered: true, start: 3 });
  expect(html('3. Pack\n4. Leave')).toContain('<ol class="answer-list" start="3">');
  const [tasks] = parseMarkdown('- [x] Book\n- [ ] Pay');
  expect(tasks).toMatchObject({
    items: [
      { text: 'Book', checked: true },
      { text: 'Pay', checked: false },
    ],
  });
  // A list straight after a paragraph line still starts a list.
  expect(parseMarkdown('Steps:\n1. a\n2. b').map((b) => b.type)).toEqual(['paragraph', 'list']);
  // A blank line between items keeps one list.
  expect(parseMarkdown('- a\n\n- b')).toHaveLength(1);
});

test('a pipe table with its alignment', () => {
  const [table] = parseMarkdown('| Day | Cost |\n|:---|---:|\n| Mon | $4 |\n| Tue |');
  expect(table).toEqual({
    type: 'table',
    head: ['Day', 'Cost'],
    align: ['left', 'right'],
    rows: [
      ['Mon', '$4'],
      ['Tue', ''],
    ],
  });
  expect(html('| A | B |\n|---|---|\n| 1 | 2 |')).toContain('<th><span>A</span></th>');
});

test('a quote holds blocks of its own', () => {
  expect(parseMarkdown('> said\n> - a')).toEqual([
    {
      type: 'quote',
      children: [
        { type: 'paragraph', lines: ['said'] },
        {
          type: 'list',
          ordered: false,
          start: 1,
          items: [{ text: 'a', checked: null, children: [] }],
        },
      ],
    },
  ]);
});

test('links: web and email open, everything else stays text', () => {
  expect(inlineMarks('see [the docs](https://example.com/a?b=1) now')).toEqual([
    { kind: 'text', text: 'see ' },
    { kind: 'link', text: 'the docs', href: 'https://example.com/a?b=1' },
    { kind: 'text', text: ' now' },
  ]);
  expect(inlineMarks('at https://example.com/x.')).toEqual([
    { kind: 'text', text: 'at ' },
    { kind: 'link', text: 'https://example.com/x', href: 'https://example.com/x' },
    { kind: 'text', text: '.' },
  ]);
  expect(inlineMarks('[x](javascript:alert(1))')[0]).toEqual({ kind: 'text', text: 'x' });
  expect(safeHref('JaVaScRiPt:alert(1)')).toBeNull();
  expect(safeHref('java\nscript:alert(1)')).toBeNull();
  expect(safeHref(' \u0001javascript:alert(1)')).toBeNull();
  expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeNull();
  expect(safeHref('vbscript:msgbox')).toBeNull();
  expect(safeHref('file:///etc/passwd')).toBeNull();
  expect(safeHref('/relative')).toBeNull();
  expect(safeHref('mailto:sam@example.com')).toBe('mailto:sam@example.com');
  // A link inside inline code is code.
  expect(inlineMarks('`[a](https://x.io)`')).toEqual([{ kind: 'code', text: '[a](https://x.io)' }]);
  const out = html('[docs](https://example.com)');
  expect(out).toContain('href="https://example.com/"');
  expect(out).toContain('rel="noopener noreferrer nofollow"');
});

test('markup in a reply is shown as text, never run or drawn', () => {
  const attack = [
    '<script>alert("x")</script>',
    '<img src=x onerror="alert(1)">',
    '[click](javascript:alert(document.cookie))',
    '[click](  JAVASCRIPT:alert(1))',
    '<a href="javascript:alert(1)">a</a>',
    '| <b>cell</b> |\n|---|\n| <iframe src="//evil"></iframe> |',
    '```\n</code></pre><script>alert(2)</script>\n```',
    '- <svg onload=alert(3)>',
  ].join('\n\n');
  const out = html(attack);
  expect(out).not.toContain('<script');
  expect(out).not.toContain('<img');
  expect(out).not.toContain('<iframe');
  expect(out).not.toContain('<svg onload');
  expect(out).not.toContain('<a href="javascript');
  expect(out).not.toMatch(/href="javascript/i);
  expect(out).not.toContain('<b>');
  expect(out).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  expect(out).toContain('&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;');
});

test('the caret follows the last words while streaming', () => {
  expect(html('Hello', true)).toContain('Hello</span><span class="caret pulse"');
  expect(html('- a\n- b', true)).toMatch(
    /b<\/span><\/span><span class="caret pulse"[^>]*><\/span><\/li><\/ul>/,
  );
  expect(html('```\ncode', true)).toMatch(/<\/div><p><span class="caret pulse"/);
  expect(html('', false)).toBe('<div class="answer"><p><span></span></p></div>');
});

test('plain answers read as before: paragraphs and line breaks', () => {
  expect(html('One\ntwo\n\nThree')).toBe(
    '<div class="answer"><p><span>One</span><span><br/>two</span></p><p><span>Three</span></p></div>',
  );
  expect(parseMarkdown('2 * 3 * 4 = 24')).toEqual([
    { type: 'paragraph', lines: ['2 * 3 * 4 = 24'] },
  ]);
});
