/**
 * Writes packages/contracts/openapi.json from the Zod schemas.
 * Run it with `bun run openapi` from the repository root.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApiJson } from '../src/openapi.ts';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'openapi.json');

writeFileSync(target, openApiJson(), 'utf8');
process.stdout.write(`openapi: wrote ${target}\n`);
