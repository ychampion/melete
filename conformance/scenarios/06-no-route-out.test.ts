import { describe, test } from 'bun:test';
import { scenario } from '../scenarios.ts';

const s = scenario(6);

// Requires a compose stack: run the probes from inside the runtime container.
describe(`conformance 6: ${s.title}`, () => {
  for (const assertion of s.assertions) {
    // The body is empty on purpose: nothing is proved until the service exists.
    test.todo(assertion, () => {});
  }
});
