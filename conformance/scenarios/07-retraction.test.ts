import { describe, test } from 'bun:test';
import { scenario } from '../scenarios.ts';

const s = scenario(7);

// Requires a compose stack: retract a record mid-job, then restart everything.
describe(`conformance 7: ${s.title}`, () => {
  for (const assertion of s.assertions) {
    // The body is empty on purpose: nothing is proved until the service exists.
    test.todo(assertion, () => {});
  }
});
