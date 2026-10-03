/**
 * The child process `bounded.ts` reads a file's words in: the kind as its one
 * argument, the bytes on stdin, and one line of JSON on stdout. It holds no
 * credential and opens nothing but its own input.
 */
import { ATTACHMENT_KINDS, type AttachmentKind } from '@melete/contracts';
import { extractText, UnreadableFile } from './extract.ts';

const kind = process.argv[2] as AttachmentKind;
let answer: unknown;
if (!ATTACHMENT_KINDS.includes(kind)) answer = { ok: false, reason: 'the file could not be read' };
else {
  const bytes = new Uint8Array(await Bun.stdin.arrayBuffer());
  try {
    answer = { ok: true, ...(await extractText(kind, bytes)) };
  } catch (error) {
    answer = {
      ok: false,
      reason: error instanceof UnreadableFile ? error.message : 'the file could not be read',
    };
  }
}
await Bun.write(Bun.stdout, JSON.stringify(answer));
process.exit(0);
