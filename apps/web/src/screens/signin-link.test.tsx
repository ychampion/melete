import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SignInLinkCard } from './Onboarding.tsx';

const noop = () => {};

test('a sign-in link opens to the account it signs in to and one button that uses it', () => {
  const html = renderToStaticMarkup(
    <SignInLinkCard account="o•••@example.com" busy={false} onSignIn={noop} onElsewise={noop} />,
  );
  expect(html).toContain('Sign in as <span');
  expect(html).toContain('o•••@example.com');
  expect(html).toContain('only after you press Sign in');
  expect(html.match(/<button/g)).toHaveLength(2);
  expect(html).toContain('<span>Sign in</span>');
  expect(html).toContain('<span>Sign in another way</span>');
});

test('while the link is checked there is nothing to press but another way in', () => {
  const html = renderToStaticMarkup(
    <SignInLinkCard account={null} busy={false} onSignIn={noop} onElsewise={noop} />,
  );
  expect(html).toContain('Checking your sign-in link');
  expect(html).not.toContain('<span>Sign in</span>');
  expect(html.match(/<button/g)).toHaveLength(1);
});

test('a press in progress cannot be repeated', () => {
  const html = renderToStaticMarkup(
    <SignInLinkCard account="o•••@example.com" busy onSignIn={noop} onElsewise={noop} />,
  );
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?<span>Sign in<\/span>/);
});
