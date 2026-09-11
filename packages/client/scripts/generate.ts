/**
 * Regenerates packages/client/src/schema.d.ts from packages/contracts/openapi.json.
 *
 * The generator is a function rather than a shell one-liner so the sync test can
 * run exactly what `bun run client:generate` runs and compare the bytes. A client
 * whose types were generated from an older document is worse than no types at
 * all, because it lies with authority.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

const here = dirname(fileURLToPath(import.meta.url));

export const openApiPath = (): string => join(here, '..', '..', 'contracts', 'openapi.json');

export const schemaPath = (): string => join(here, '..', 'src', 'schema.d.ts');

const BANNER = `/**
 * Generated from packages/contracts/openapi.json by \`bun run client:generate\`.
 * Do not edit by hand: the sync test compares this file against a fresh run.
 */

`;

/** The exact bytes schema.d.ts should hold for the current openapi.json. */
export async function generateSchemaTypes(): Promise<string> {
  const document = JSON.parse(readFileSync(openApiPath(), 'utf8'));
  const ast = await openapiTS(document, { alphabetize: true });
  return `${BANNER}${astToString(ast)}`;
}

if (import.meta.main) {
  const target = schemaPath();
  writeFileSync(target, await generateSchemaTypes(), 'utf8');
  process.stdout.write(`client:generate: wrote ${target}\n`);
}
