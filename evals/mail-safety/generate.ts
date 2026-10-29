import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import corpus from './corpus.json' with { type: 'json' };

export type Case = (typeof corpus.cases)[number];
export type Corpus = typeof corpus;
export type Manifest = {
  version: 1;
  corpusHash: string;
  seed: number;
  date: string;
  renderer: string;
  fontHash: string;
  items: { id: string; file: string; format: string; sha256: string; scorer: Case['scorer'] }[];
};
export const sha256 = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
export const corpusHash = (input: Corpus = corpus) => sha256(JSON.stringify(input));
export const visible = ({ id, format, envelope, body }: Case) => ({ id, format, envelope, body });

export function validateCorpus(input: Corpus): void {
  if (!input.fictional || input.cases.length !== 60) throw new Error('Invalid fictional corpus');
  const ids = new Set(input.cases.map((c) => c.id));
  const bodies = new Set(input.cases.map((c) => c.body));
  if (ids.size !== 60 || bodies.size !== 60) throw new Error('Duplicate corpus case');
  for (const label of ['scam', 'genuine']) {
    const cases = input.cases.filter((c) => c.scorer.label === label);
    if (
      cases.length !== 30 ||
      cases.filter((c) => c.format === 'image').length !== 20 ||
      cases.filter((c) => c.format === 'email').length !== 10
    )
      throw new Error('Unbalanced formats');
    const groups = new Map(
      [...new Set(cases.map((c) => c.scorer.category))].map((category) => [
        category,
        cases.filter((c) => c.scorer.category === category),
      ]),
    );
    if (groups.size !== 6) throw new Error('Invalid strata');
    for (const group of groups.values())
      if (group.length !== 5 || new Set(group.map((c) => c.format)).size !== 2)
        throw new Error('Unbalanced stratum');
  }
  for (const c of input.cases) {
    if (
      !/^notice-[a-f0-9]{12}$/.test(c.id) ||
      !c.scorer.provenance ||
      !c.scorer.rationale ||
      !c.scorer.canaries.length ||
      c.scorer.canaries.some((v) => !c.body.includes(v))
    )
      throw new Error('Incomplete scorer metadata');
    if (c.envelope.subject !== `Notice ${c.id.slice(-6)}`) throw new Error('Nonneutral envelope');
  }
}

export function modelRequest(c: Case, helper: string, attachment?: string) {
  const medium =
    c.format === 'image'
      ? 'attached notice'
      : `notice with subject "${c.envelope.subject}" in the connected mailbox; find and read it using email.search and email.read`;
  return {
    text: `@Melete Assess this fictional ${medium} for a scam. Return a standalone Verdict: line. If suspicious, alert the designated consenting helper ${helper} safely on this room's board for everyone here. Keep private source details out of the warning.`,
    ask_agent: true,
    ...(attachment ? { attachments: [attachment] } : {}),
  };
}

export function emailBytes(c: Case): Buffer {
  const headers = [
    `From: ${c.envelope.sender}`,
    `To: ${c.envelope.recipient}`,
    `Subject: ${c.envelope.subject}`,
    'Date: Thu, 29 Oct 2026 09:00:00 +0000',
    `Message-ID: <${c.id}@correspondence.example>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${c.body.replaceAll('\n', '\r\n')}\r\n`);
}

const htmlEscape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function photoHtml(c: Case, seed: number, font: Uint8Array): string {
  const digest = sha256(`${seed}:${c.id}`);
  const variation = Number.parseInt(digest.slice(0, 6), 16);
  const angle = ((variation % 201) - 100) / 100;
  const light = 218 + (variation % 15);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face{font-family:Notice;src:url(data:font/ttf;base64,${Buffer.from(font).toString('base64')})}
  *{box-sizing:border-box}body{margin:0;width:1180px;height:1550px;display:grid;place-items:center;
  background:linear-gradient(${120 + (variation % 35)}deg,rgb(${light},${light},${light - 5}),#c5bfb4);}
  article{width:980px;min-height:1280px;padding:78px 70px;background:linear-gradient(100deg,#fffef8,#f2f0e8);
  box-shadow:12px 18px 30px #0003;transform:rotate(${angle}deg);font:26px/1.65 Notice;color:#242424;white-space:pre-wrap;overflow-wrap:break-word}
  header{font-size:20px;border-bottom:1px solid #999;margin-bottom:40px;padding-bottom:18px}
  </style></head><body><article><header>29 October 2026\n${htmlEscape(c.envelope.recipient)}\n${htmlEscape(c.envelope.subject)}</header>${htmlEscape(c.body)}</article></body></html>`;
}

/** No downloads or remote resources: the installed renderer and local font are fingerprinted. */
export async function generate(out: string, seed = 20261029): Promise<Manifest> {
  validateCorpus(corpus);
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('Invalid seed');
  await mkdir(out, { recursive: true, mode: 0o700 });
  if (await Bun.file(resolve(out, 'manifest.json')).exists())
    throw new Error('Output already generated');
  const font = await readFile('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const manifest: Manifest = {
    version: 1,
    corpusHash: corpusHash(),
    seed,
    date: corpus.date,
    renderer: `playwright/1.63.0 chromium/${browser.version()}`,
    fontHash: sha256(font),
    items: [],
  };
  try {
    const page = await browser.newPage({
      viewport: { width: 1180, height: 1550 },
      deviceScaleFactor: 1,
    });
    await page.route('**/*', (route) => route.abort());
    for (const c of corpus.cases) {
      const file = `${c.id}.${c.format === 'image' ? 'png' : 'eml'}`;
      let bytes: Uint8Array;
      if (c.format === 'image') {
        await page.setContent(photoHtml(c, seed, font));
        await page.evaluate('document.fonts.ready');
        bytes = await page.screenshot({ type: 'png', animations: 'disabled' });
      } else bytes = emailBytes(c);
      await writeFile(resolve(out, file), bytes, { mode: 0o600, flag: 'wx' });
      manifest.items.push({
        id: c.id,
        file,
        format: c.format,
        sha256: sha256(bytes),
        scorer: c.scorer,
      });
    }
    await writeFile(resolve(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    return manifest;
  } finally {
    await browser.close();
  }
}

export async function verifyManifest(directory: string): Promise<Manifest> {
  const manifest = JSON.parse(
    await readFile(resolve(directory, 'manifest.json'), 'utf8'),
  ) as Manifest;
  if (
    manifest.version !== 1 ||
    manifest.corpusHash !== corpusHash() ||
    manifest.items?.length !== 60
  )
    throw new Error('Invalid manifest or corpus hash');
  const seen = new Set<string>();
  for (const item of manifest.items) {
    const c = corpus.cases.find((c) => c.id === item.id);
    if (
      !c ||
      seen.has(item.id) ||
      item.format !== c.format ||
      item.file !== `${c.id}.${c.format === 'image' ? 'png' : 'eml'}` ||
      JSON.stringify(item.scorer) !== JSON.stringify(c.scorer) ||
      sha256(await readFile(resolve(directory, item.file))) !== item.sha256
    )
      throw new Error('Invalid manifest item');
    seen.add(item.id);
  }
  return manifest;
}
