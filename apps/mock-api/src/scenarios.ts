/**
 * Loads the scenario files. Adding a case to the mock is a JSON file, not a
 * branch, and a file that does not parse stops the server at start-up rather
 * than halfway through someone's demo.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScenario, type Scenario } from './scenario.ts';

export const scenariosDir = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), '..', 'scenarios');

export function loadScenarios(directory = scenariosDir()): Scenario[] {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const scenarios = files.map((name) => {
    try {
      return parseScenario(JSON.parse(readFileSync(join(directory, name), 'utf8')));
    } catch (error) {
      throw new Error(`scenario ${name} is invalid: ${String(error)}`);
    }
  });

  const fallbacks = scenarios.filter((scenario) => scenario.fallback);
  if (fallbacks.length !== 1) {
    throw new Error(`exactly one scenario must be the fallback; found ${fallbacks.length}`);
  }
  return scenarios;
}
