/**
 * Runs a try's value pattern over its output, apart from the service, so a
 * pattern that never finishes is stopped with its worker. Answers with the
 * last match's capture group, or null.
 */
declare const self: Worker;

self.onmessage = (event: MessageEvent<{ output: string; pattern: string }>) => {
  const { output, pattern } = event.data;
  let found: string | null = null;
  for (const match of output.matchAll(new RegExp(pattern, 'gm'))) found = match[1] ?? null;
  self.postMessage(found);
};
