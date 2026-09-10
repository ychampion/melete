import { describe, test } from 'bun:test';
import { scenario } from '../scenarios.ts';

const s = scenario(5);

// Requires a compose stack: kill the runtime mid-stream and after a tool completes.
describe(`conformance 5: ${s.title}`, () => {
  for (const assertion of s.assertions) {
    // The body is empty on purpose: nothing is proved until the service exists.
    test.todo(assertion, () => {});
  }
});
