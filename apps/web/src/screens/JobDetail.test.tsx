import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { API_BASE_URL } from '../api.ts';
import { ArtifactPlayer } from './JobDetail.tsx';

test('the audio player retrieves the artifact by ID through its content endpoint', () => {
  const id = `art_01J${'0'.repeat(23)}`;
  const rendered = renderToStaticMarkup(
    <ArtifactPlayer
      receipt={{
        detail: {
          kind: 'artifact',
          path: 'artifacts/episode.wav',
          mime: 'audio/wav',
          artifact_id: id,
          bytes: 100,
        },
      }}
    />,
  );
  expect(rendered).toContain(`src="${API_BASE_URL}/artifacts/${id}/content"`);
  expect(rendered).toContain(`href="${API_BASE_URL}/artifacts/${id}/content"`);
  expect(rendered).not.toContain('/artifacts/artifacts/');
});

test('a receipt without a retrievable artifact ID does not offer a broken player', () => {
  const rendered = renderToStaticMarkup(
    <ArtifactPlayer
      receipt={{
        detail: {
          kind: 'artifact',
          path: 'artifacts/older.wav',
          mime: 'audio/wav',
        },
      }}
    />,
  );
  expect(rendered).not.toContain('<audio');
  expect(rendered).toContain('artifacts/older.wav');
});
