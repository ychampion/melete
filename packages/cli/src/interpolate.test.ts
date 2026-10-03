// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are Compose substitutions, not templates.
import { describe, expect, test } from 'bun:test';
import { interpolate, interpolateDocument, type Missing } from './interpolate.ts';

const values = { SET: 'value', EMPTY: '', TAG: 'main' };

describe('Compose interpolation', () => {
  test('a plain reference is its value, and an unset one is empty', () => {
    expect(interpolate('${SET} $SET ${UNSET}x', values)).toBe('value value x');
  });

  test('a doubled dollar is one literal dollar and is never substituted', () => {
    expect(interpolate('$$SET and $${SET}', values)).toBe('$SET and ${SET}');
  });

  test('defaults tell an empty value from an unset one', () => {
    expect(interpolate('${EMPTY:-d}|${EMPTY-d}|${UNSET-d}', values)).toBe('d||d');
  });

  test('alternatives apply only when the value is there', () => {
    expect(interpolate('${SET:+on}|${EMPTY:+on}|${EMPTY+on}|${UNSET+on}', values)).toBe('on||on|');
  });

  test("the published image reference resolves as Compose's does", () => {
    const reference =
      '${MELETE_IMAGE_TAG:+${MELETE_IMAGE_REGISTRY:-ghcr.io/ychampion}/}melete-service:${MELETE_IMAGE_TAG:-local}';
    expect(interpolate(reference, { MELETE_IMAGE_TAG: 'main' })).toBe(
      'ghcr.io/ychampion/melete-service:main',
    );
    expect(interpolate(reference, { MELETE_IMAGE_TAG: '' })).toBe('melete-service:local');
    expect(
      interpolate(reference, { MELETE_IMAGE_TAG: 'v1', MELETE_IMAGE_REGISTRY: 'r.example/x' }),
    ).toBe('r.example/x/melete-service:v1');
  });

  test('a required variable that is empty or unset is reported once by name', () => {
    const missing: Missing[] = [];
    interpolate(
      '${EMPTY:?set EMPTY} ${SET:?never} ${UNSET?set UNSET} ${EMPTY?fine}',
      values,
      missing,
    );
    expect(missing).toEqual([
      { name: 'EMPTY', message: 'set EMPTY' },
      { name: 'UNSET', message: 'set UNSET' },
    ]);
  });

  test('every string in a document is substituted and keys are kept', () => {
    const missing: Missing[] = [];
    const document = interpolateDocument(
      { services: { web: { ports: ['127.0.0.1:${PORT:-3101}:3000'], image: '${TAG}' } } },
      values,
      missing,
    );
    expect(document).toEqual({
      services: { web: { ports: ['127.0.0.1:3101:3000'], image: 'main' } },
    });
  });
});
