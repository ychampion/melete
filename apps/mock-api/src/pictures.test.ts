/**
 * A scenario card that shows a picture names it by a path on the mock, and the
 * mock answers that path with the picture.
 */
import { expect, test } from 'bun:test';
import { scenarioPictures } from './app.ts';
import { createMock } from './index.ts';

test('every picture a scenario card names is served', async () => {
  const mock = createMock({ speed: 0 });
  const named = mock.scenarios.flatMap((scenario) =>
    scenario.steps.flatMap((step) => (step.step === 'card' && step.image ? [step.image.src] : [])),
  );
  expect(named).toContain('/restaurant.jpg');
  expect(scenarioPictures(mock.scenarios).sort()).toEqual([...new Set(named)].sort());
  for (const src of named) {
    const response = await mock.app.request(src);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    const bytes = new Uint8Array(await response.arrayBuffer());
    // A JPEG starts with its start-of-image marker.
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  }
});

test('a path that no card names is not a picture', async () => {
  const mock = createMock({ speed: 0 });
  expect((await mock.app.request('/elsewhere.jpg')).status).toBe(404);
});
