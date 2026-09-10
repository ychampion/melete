import { describe, test } from 'bun:test';
import { scenario } from '../scenarios.ts';

const s = scenario(3);

// Requires a compose stack and the test connector in drop-ack mode.
describe(`conformance 3: ${s.title}`, () => {
  for (const assertion of s.assertions) {
    // The body is empty on purpose: nothing is proved until the service exists.
    test.todo(assertion, () => {});
  }
});
