/**
 * Git's pkt-line framing, as far as the egress relay needs it: reading the
 * command list at the head of a push (`git-receive-pack` request), reading
 * the status a server reports back, and writing a status of its own so a
 * held or refused push is explained by `git` itself.
 *
 * A pkt-line is four hex digits giving its whole length, then the payload;
 * `0000` is a flush. The push request is: any `shallow` lines, the commands
 * (`old new ref`, the first followed by NUL and the capabilities), a flush,
 * then, when `push-options` was asked for, the options and a flush, and then
 * the pack. Anything else (a signed push certificate, an unknown line, a
 * malformed length) is not read here, and the caller treats the request as
 * one it cannot read.
 */

export type RefUpdate = { ref: string; old: string; new: string };

export type ReceivePackCommands = {
  updates: RefUpdate[];
  capabilities: string[];
  pushOptions: string[];
  shallow: string[];
  /** Bytes of the request before the pack: everything the commands are. */
  length: number;
};

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Ref names git itself would accept, and nothing that could be read two ways. */
const REF_NAME = /^refs\/[!-~]+$/;
const MAX_COMMANDS = 1000;

/** Whether an object id is all zeros: no object, as the old side of a create or the new side of a delete. */
export const isZeroId = (id: string) => /^0+$/.test(id);

type Line = { kind: 'flush' } | { kind: 'data'; data: Buffer };

/** One pkt-line at `offset`, or null when the bytes there are not one. */
function readLine(body: Buffer, offset: number): { line: Line; next: number } | null {
  if (offset + 4 > body.length) return null;
  const head = body.subarray(offset, offset + 4).toString('latin1');
  if (!/^[0-9a-f]{4}$/.test(head)) return null;
  const size = Number.parseInt(head, 16);
  if (size === 0) return { line: { kind: 'flush' }, next: offset + 4 };
  // 0001-0003 are protocol v2 markers, never part of a push request.
  if (size < 4 || offset + size > body.length) return null;
  return {
    line: { kind: 'data', data: body.subarray(offset + 4, offset + size) },
    next: offset + size,
  };
}

const text = (data: Buffer) => {
  const value = data.toString('utf8');
  return value.endsWith('\n') ? value.slice(0, -1) : value;
};

/**
 * The commands at the head of a push request, or null when they cannot be
 * read exactly. A body that is only a flush (git's probe before a large push)
 * has no commands.
 */
export function parseReceivePack(body: Buffer): ReceivePackCommands | null {
  const updates: RefUpdate[] = [];
  const shallow: string[] = [];
  let capabilities: string[] | null = null;
  let offset = 0;
  for (;;) {
    const read = readLine(body, offset);
    if (!read) return null;
    offset = read.next;
    if (read.line.kind === 'flush') break;
    let line = text(read.line.data);
    if (capabilities === null && updates.length === 0 && line.startsWith('shallow ')) {
      const id = line.slice('shallow '.length);
      if (!OBJECT_ID.test(id)) return null;
      shallow.push(id);
      continue;
    }
    if (capabilities === null) {
      const nul = line.indexOf('\0');
      if (nul < 0) return null;
      capabilities = line
        .slice(nul + 1)
        .split(' ')
        .filter(Boolean);
      line = line.slice(0, nul);
    } else if (line.includes('\0')) return null;
    const parts = line.split(' ');
    if (parts.length !== 3) return null;
    const [old, next, ref] = parts as [string, string, string];
    if (!OBJECT_ID.test(old) || !OBJECT_ID.test(next) || old.length !== next.length) return null;
    if (!REF_NAME.test(ref) || ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock'))
      return null;
    if (isZeroId(old) && isZeroId(next)) return null;
    updates.push({ ref, old, new: next });
    if (updates.length > MAX_COMMANDS) return null;
  }
  if (updates.length === 0) {
    // Only a flush: nothing is asked for, and nothing may follow.
    return offset === body.length && shallow.length === 0
      ? { updates, capabilities: [], pushOptions: [], shallow, length: offset }
      : null;
  }
  const pushOptions: string[] = [];
  if (capabilities?.includes('push-options')) {
    for (;;) {
      const read = readLine(body, offset);
      if (!read) return null;
      offset = read.next;
      if (read.line.kind === 'flush') break;
      pushOptions.push(text(read.line.data));
      if (pushOptions.length > MAX_COMMANDS) return null;
    }
  }
  // Whatever follows is the pack, or nothing when every command deletes.
  const rest = body.subarray(offset);
  const deletesOnly = updates.every((update) => isZeroId(update.new));
  if (deletesOnly ? rest.length !== 0 : !rest.subarray(0, 4).equals(Buffer.from('PACK')))
    return null;
  return {
    updates: [...updates].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)),
    capabilities: capabilities ?? [],
    pushOptions,
    shallow,
    length: offset,
  };
}

/** The payload of every band-1 packet of a side-band answer, joined; null when it is not one. */
function demultiplex(body: Buffer): Buffer | null {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    const read = readLine(body, offset);
    if (!read) return null;
    offset = read.next;
    if (read.line.kind === 'flush') break;
    const band = read.line.data[0];
    if (band === 1) parts.push(read.line.data.subarray(1));
    else if (band === 3) return null;
  }
  return Buffer.concat(parts);
}

export type ReportedRef = { ref: string; ok: boolean; reason?: string };
export type PushReport = { unpack: string; refs: ReportedRef[] };

/**
 * The status a server reported for a push, read from its answer: plain or
 * inside side-band packets, `report-status` or `report-status-v2`. Null when
 * the answer holds no report.
 */
export function parseReportStatus(body: Buffer): PushReport | null {
  const tryRead = (input: Buffer): PushReport | null => {
    let unpack: string | null = null;
    const refs: ReportedRef[] = [];
    let offset = 0;
    while (offset < input.length) {
      const read = readLine(input, offset);
      if (!read) return null;
      offset = read.next;
      if (read.line.kind === 'flush') break;
      const line = text(read.line.data);
      if (unpack === null) {
        if (!line.startsWith('unpack ')) return null;
        unpack = line.slice('unpack '.length);
      } else if (line.startsWith('ok ')) refs.push({ ref: line.slice(3), ok: true });
      else if (line.startsWith('ng ')) {
        const rest = line.slice(3);
        const space = rest.indexOf(' ');
        refs.push(
          space < 0
            ? { ref: rest, ok: false }
            : { ref: rest.slice(0, space), ok: false, reason: rest.slice(space + 1) },
        );
      }
      // `option` lines of report-status-v2 describe the ref above them; not needed here.
    }
    return unpack === null ? null : { unpack, refs };
  };
  const direct = tryRead(body);
  if (direct) return direct;
  const inner = demultiplex(body);
  return inner ? tryRead(inner) : null;
}

const packet = (payload: Buffer) =>
  Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, '0')), payload]);

/** The longest payload one packet carries, with its band byte. */
const MAX_PAYLOAD = 65_515;

/**
 * A push answer in which the server refuses every ref with `message`, in the
 * shape the client asked for, so `git push` prints it beside each ref
 * (`! [remote rejected] … (message)`) and, through the progress band,
 * on a `remote:` line of its own. Null when the client asked for no report,
 * which leaves only a plain HTTP answer.
 */
export function refusedPushAnswer(commands: ReceivePackCommands, message: string): Buffer | null {
  const caps = new Set(commands.capabilities);
  if (!caps.has('report-status') && !caps.has('report-status-v2')) return null;
  // One line: git reads a reason up to the end of its line.
  const reason = message.replace(/[\r\n\0]+/g, ' ').trim();
  const report = Buffer.concat([
    packet(Buffer.from('unpack ok\n')),
    ...commands.updates.map((update) => packet(Buffer.from(`ng ${update.ref} ${reason}\n`))),
    Buffer.from('0000'),
  ]);
  if (!caps.has('side-band-64k') && !caps.has('side-band')) return report;
  const limit = caps.has('side-band-64k') ? MAX_PAYLOAD : 995;
  const bands: Buffer[] = [];
  const progress = Buffer.from(`${reason}\n`);
  for (let at = 0; at < progress.length; at += limit)
    bands.push(packet(Buffer.concat([Buffer.from([2]), progress.subarray(at, at + limit)])));
  for (let at = 0; at < report.length; at += limit)
    bands.push(packet(Buffer.concat([Buffer.from([1]), report.subarray(at, at + limit)])));
  return Buffer.concat([...bands, Buffer.from('0000')]);
}
