import { describe, test } from 'bun:test';
import { scenario } from '../scenarios.ts';

const s = scenario(2);

// Requires a compose stack: stall attempt A, expire its lease, start B, then resume A.
describe(`conformance 2: ${s.title}`, () => {
  for (const assertion of s.assertions) {
    // The body is empty on purpose: nothing is proved until the service exists.
    test.todo(assertion, () => {});
  }
});
