import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { InstallLinksRow, installLinks } from './InstallLinks.tsx';

test('only the links the installation set are shown, in order', () => {
  expect(installLinks(null)).toEqual([]);
  expect(installLinks({})).toEqual([]);
  expect(
    installLinks({
      support_url: 'mailto:help@example.net',
      terms_url: 'https://example.net/terms',
      privacy_url: 'https://example.net/privacy',
    }),
  ).toEqual([
    { label: 'Terms', href: 'https://example.net/terms' },
    { label: 'Privacy', href: 'https://example.net/privacy' },
    { label: 'Help and support', href: 'mailto:help@example.net' },
  ]);
  expect(installLinks({ privacy_url: 'https://example.net/privacy' })).toEqual([
    { label: 'Privacy', href: 'https://example.net/privacy' },
  ]);
});

test('nothing but a web page, or a mail address for support, becomes a link', () => {
  expect(
    installLinks({
      terms_url: 'javascript:alert(1)',
      privacy_url: 'mailto:privacy@example.net',
      support_url: 'not a link',
    }),
  ).toEqual([]);
});

test('with no links set nothing is drawn; with some, each opens on its own', () => {
  expect(renderToStaticMarkup(<InstallLinksRow links={[]} />)).toBe('');
  const html = renderToStaticMarkup(
    <InstallLinksRow links={installLinks({ terms_url: 'https://example.net/terms' })} />,
  );
  expect(html).toContain('href="https://example.net/terms"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('>Terms</a>');
});
