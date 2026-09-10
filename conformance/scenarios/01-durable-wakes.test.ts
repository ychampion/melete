import { describe, test } from 'bun:test';
import { scenario } from '../scenarios.ts';

const s = scenario(1);

// Requires a compose stack: kill the service between the transition commit and the enqueue.
describe(`conformance 1: ${s.title}`, () => {
  for (const assertion of s.assertions) {
    // The body is empty on purpose: nothing is proved until the service exists.
    test.todo(assertion, () => {});
  }
});
