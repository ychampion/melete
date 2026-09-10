import { describe, test } from 'bun:test';
import { scenario } from '../scenarios.ts';

const s = scenario(4);

// Requires a compose stack: approve, tamper, admit; and cancel racing a dispatch.
describe(`conformance 4: ${s.title}`, () => {
  for (const assertion of s.assertions) {
    // The body is empty on purpose: nothing is proved until the service exists.
    test.todo(assertion, () => {});
  }
});
