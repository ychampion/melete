import { expect, test } from 'bun:test';
import { visibleNames } from './visible-name-check.ts';

const file = 'apps/web/src/screens/Planted.tsx';

test('a literal name in JSX text or a read attribute is caught', () => {
  const source = `export const A = () => (
  <div title="About Melete">
    <p>Melete checks what it needs.</p>
    <input placeholder="Ask Melete to handle something" aria-label={'Melete says'} />
    <span>{busy ? 'Melete is working' : 'Done'}</span>
  </div>
);`;
  expect(visibleNames(file, source).map((finding) => finding.line)).toEqual([2, 3, 4, 4, 5]);
});

test('names read from the installation, code names and comments pass', () => {
  const source = `import { MeleteMark } from '../design/mark.tsx';
// Melete is the default name.
export const A = () => (
  <div title={instanceName()}>
    {/* Melete draws this */}
    <MeleteMark width={20} />
    <p>{assistantName()} checks what it needs.</p>
    <input placeholder={\`Ask \${assistantName()} to handle something\`} data-x="Melete" />
  </div>
);`;
  expect(visibleNames(file, source)).toEqual([]);
});

test('the allow-list covers only its own file and words', () => {
  const line = '<p>On the computer, from a copy of Melete with Bun installed:</p>';
  expect(visibleNames('apps/web/src/screens/Devices.tsx', line)).toEqual([]);
  expect(visibleNames(file, line)).toHaveLength(1);
});
