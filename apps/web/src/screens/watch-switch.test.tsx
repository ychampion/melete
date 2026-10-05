import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Connection } from '../experience/types.ts';
import { WatchSwitch, watchWords } from './Settings.tsx';

const account = (app: string, watching: boolean): Connection => ({
  id: 'conn_1',
  app,
  label: app === 'Mail' ? 'Work mail' : 'Work calendar',
  status: 'connected',
  access: 'read_only',
  watching,
});

test('the switch says what a watched mailbox and calendar are read for', () => {
  const mail = renderToStaticMarkup(
    <WatchSwitch connection={account('Mail', true)} onChanged={() => {}} />,
  );
  expect(mail).toContain('Watch this account for changes');
  expect(mail).toContain('Melete reads new mail’s sender and subject to notice what needs you.');
  expect(mail).toContain('aria-checked="true"');
  const calendar = renderToStaticMarkup(
    <WatchSwitch connection={account('Calendar', true)} onChanged={() => {}} />,
  );
  expect(calendar).toContain(
    'Melete reads each event’s title, time and place to notice changes and clashes.',
  );
});

test('a watched Drive says it reads file names, changes and sharing, never contents', () => {
  const drive = renderToStaticMarkup(
    <WatchSwitch connection={account('Drive', true)} onChanged={() => {}} />,
  );
  expect(drive).toContain(
    'Melete reads each file’s name, last change and sharing, never its contents, to notice what is still untouched.',
  );
  expect(drive).not.toContain('mail');
});

test('off, it says the account is still read for what the person asked to watch', () => {
  for (const app of ['Mail', 'Calendar']) {
    const off = renderToStaticMarkup(
      <WatchSwitch connection={account(app, false)} onChanged={() => {}} />,
    );
    expect(off).toContain('Off. Melete still reads this account for things you asked it to watch.');
    expect(off).toContain('aria-checked="false"');
    expect(off).not.toContain('Melete reads new mail');
  }
  expect(watchWords('Calendar', false)).toBe(watchWords('Mail', false));
});
