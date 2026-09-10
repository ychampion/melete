import { describe, test } from 'bun:test';
import { scenario } from '../scenarios.ts';

const s = scenario(8);

// Requires a compose stack: the fake provider always, a real one when a key is present.
describe(`conformance 8: ${s.title}`, () => {
  for (const assertion of s.assertions) {
    // The body is empty on purpose: nothing is proved until the service exists.
    test.todo(assertion, () => {});
  }
});
