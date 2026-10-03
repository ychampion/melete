/**
 * Recorded request corpora for the adapters' tests: `.http` files whose
 * blocks each carry the class a request belongs to (`read`, `write` or
 * `refuse`), the request line, headers and body (plain, or base64 where it is
 * binary). Test code only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { upstreamHeaders } from '../intercept.ts';
import type { InterceptedRequest } from './types.ts';

export type Recorded = {
  file: string;
  label: 'read' | 'write' | 'refuse';
  request: InterceptedRequest;
};

/** The requests in one `.http` file, each with the class its label says it is. */
export function recordedFile(dir: string, file: string, placeholders: string[]): Recorded[] {
  const text = readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');
  return text
    .split(/^### /m)
    .slice(1)
    .map((block) => {
      const [labelLine = '', requestLine = '', ...rest] = block.split('\n');
      const [label, encoding] = labelLine.trim().split(' ');
      const [method = '', address = ''] = requestLine.split(' ');
      const blank = rest.indexOf('');
      const headerLines = rest.slice(0, blank < 0 ? rest.length : blank);
      const bodyText = (blank < 0 ? [] : rest.slice(blank + 1)).join('\n').replace(/\n+$/, '');
      const raw: Record<string, string> = {};
      for (const line of headerLines) {
        const colon = line.indexOf(':');
        raw[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      const url = new URL(address);
      return {
        file,
        label: label as Recorded['label'],
        request: {
          host: url.hostname,
          method,
          // As sent: URL would resolve dot segments the relay is shown raw.
          path: address.slice(`https://${url.host}`.length).split('?')[0] ?? '',
          query: url.search.slice(1),
          headers: upstreamHeaders(raw, placeholders),
          body:
            encoding === 'base64'
              ? Buffer.from(bodyText.replace(/\s+/g, ''), 'base64')
              : Buffer.from(bodyText),
        },
      };
    });
}

/** Every request in every `.http` file of a directory, in file order. */
export function recordedCorpus(dir: string, placeholders: string[]): Recorded[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.http'))
    .sort()
    .flatMap((file) => recordedFile(dir, file, placeholders));
}
