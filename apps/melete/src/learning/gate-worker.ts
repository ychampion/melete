import { decidePromotion } from './gate.ts';

// This entry point is compiled by the service and launched with Node's filesystem permission boundary.
const chunks: Buffer[] = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  const buffer = Buffer.from(chunk);
  bytes += buffer.byteLength;
  if (bytes > 262144) throw new Error('gate_input_too_large');
  chunks.push(buffer);
}
try {
  process.stdout.write(
    JSON.stringify(decidePromotion(JSON.parse(Buffer.concat(chunks).toString('utf8')))),
  );
} catch {
  process.stdout.write(
    JSON.stringify({ decision: 'reject', reason: 'invalid_gate_input', definitionHash: '' }),
  );
  process.exitCode = 1;
}
