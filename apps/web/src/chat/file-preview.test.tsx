/**
 * A saved file opened in place: a PDF's local address goes in an object of the
 * PDF type, which Melete's own frame policy does not blank, and text is never
 * rendered as a page.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SavedFileShown } from './parts.tsx';

const href = '/api/files/act_1/content';

test('a PDF is shown in an object of the PDF type, never a frame, with a download to fall back on', () => {
  const html = renderToStaticMarkup(
    <SavedFileShown
      shown={{ kind: 'pdf', url: 'blob:https://melete.test/1' }}
      name="list.pdf"
      href={href}
    />,
  );
  expect(html).toContain('<object');
  expect(html).toContain('type="application/pdf"');
  expect(html).toContain('data="blob:https://melete.test/1"');
  expect(html).not.toContain('<iframe');
  expect(html).toContain(`href="${href}"`);
});

test('a web page saved as a file is shown as its text, not rendered', () => {
  const html = renderToStaticMarkup(
    <SavedFileShown
      shown={{ kind: 'text', text: '<script>alert(1)</script>', truncated: false }}
      name="page.html"
      href={href}
    />,
  );
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<object');
});
