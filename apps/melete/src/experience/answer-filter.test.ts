import { expect, test } from 'bun:test';
import { AnswerStream, answerStream, answerText, HIDDEN } from './answer-filter.ts';

// Shaped like real keys, made up for these tests.
const OPENAI_KEY = 'sk-proj-Q7vLm2Xr9TbW4kZp8NcY3dHs';
const FIREWORKS_KEY = 'fw_3ZkQw9Lr7Tx2Mv5Bn8Pc4Yd';
const SIGNED = 'eyJhbGciOiJIUzI1NiJ9.eyJqb2JfaWQiOiJqb2JfMDEifQ.c2lnbmF0dXJlLXRoYXQtaXMtbG9uZw';
const HASH = '9f2c4e1a7b3d5f6e8a0c2b4d6f8e0a1c3b5d7f9e1a3c5b7d9f0e2a4c6b8d0f1e';

const NOVA = "I'm Nova. Running on `accounts/fireworks/models/deepseek-v4p1-flash`.";

/** Answers a model really gives, each shown exactly as written. */
const KEPT = [
  NOVA,
  'I run on claude-sonnet-5 today; gpt-5.1 and deepseek-v4 work too.',
  'The draft to someone@email.com is ready. Send it from the draft card when it reads right.',
  'Maya’s new address is maya@files.com, and the old one at web.de still forwards for a month.',
  'I saved the notes as test.txt. The guide on web.dev covers the rest.',
  'See [the setup guide](https://docs.example.com/setup/models#fireworks) and **restart** after.',
  '[your name]\n\nSay the word and I will send it.',
  'The config lives at `C:\\Users\\sam\\notes\\plan.md` and `/home/sam/.config/app/settings.toml`.',
  'I would call email.send next, once you approve the draft.',
  'Here is the shape:\n\n```json\n{"tool": "email.send", "to": "sam@example.com", "subject": "Hi"}\n```\n\nPaste it into the form.',
  '```ts\nconst client = new Client({ baseUrl: "https://api.example.com/v1" });\n```',
  'Your share link: https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd/edit',
  '- Step one: open https://example.com/settings\n- Step two: pick **Models**\n- Step three: paste the key',
  'Set max_tokens: 4000 and temperature: 0.2 in the request.',
  'Two lists: [1, 2, 3] and [4, 5].',
  '{"city": "Lisbon", "days": 3}',
  'The commit 3f9a2c1b7d8e4f5a6b7c8d9e0f1a2b3c4d5e6f7a fixed it.',
  'Plan for Tuesday:\r\n1. Gym at 7\r\n2. Call Sam\r\n\r\n3. Groceries',
];

/** A long answer: a list, a code block, a table, and a key and a record in among them. */
const LONG = [
  '# Moving the service',
  '',
  ...Array.from(
    { length: 40 },
    (_, n) => `- Step ${n + 1}: copy \`/srv/app/data/part-${n}.json\` to the new host.`,
  ),
  '',
  '```yaml',
  ...Array.from(
    { length: 60 },
    (_, n) => `  service_${n}: { image: "registry.example.com/app:${n}", replicas: 2 }`,
  ),
  '  api_key: "sk-live-A1b2C3d4E5f6G7h8I9j0K1l2"',
  '```',
  '',
  '| Host | Model |',
  '|---|---|',
  '| a.example.com | accounts/fireworks/models/deepseek-v4p1-flash |',
  '',
  'Then {"tool_call": {"name": "files.write", "arguments": {"path": "notes.md"}}} and done.',
].join('\n');

test('ordinary answers are kept exactly, model ids, paths, links and addresses included', () => {
  for (const answer of KEPT) expect(answerText(answer)).toBe(answer);
});

test('hashes, commit ids, UUIDs and checksums are shown as written', () => {
  for (const answer of [
    `The SHA-256 of the file is ${HASH}.`,
    `${HASH}  release.tar.gz`,
    `sha256sum says ${HASH.toUpperCase()}`,
    'Commit 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39 is on main, short id 3f2a9c1.',
    'The id is 123e4567-e89b-12d3-a456-426614174000 and the md5 is d41d8cd98f00b204e9800998ecf8427e.',
  ])
    expect(answerText(answer)).toBe(answer);
  // A key with a known prefix, or a hash named as a token or a payload, is still hidden.
  expect(answerText(`token: ${HASH}`)).toBe(`token: ${HIDDEN}`);
  expect(answerText(`The payload hash was ${HASH}.`)).toBe(`The payload hash was ${HIDDEN}.`);
});

test('a hex value said to be a secret is hidden, however it is worded', () => {
  const said: [string, string][] = [
    [`api_key=${HASH}`, `api_key=${HIDDEN}`],
    [`secret: ${HASH}`, `secret: ${HIDDEN}`],
    [`My API key is ${HASH}, keep it.`, `My API key is ${HIDDEN}, keep it.`],
    [`Your token ${HASH} expires soon.`, `Your token ${HIDDEN} expires soon.`],
    [`The password is ${HASH.toUpperCase()}`, `The password is ${HIDDEN}`],
    [`The signing key: ${HASH.slice(0, 40)}`, `The signing key: ${HIDDEN}`],
    [`Authorization: Bearer ${HASH}`, `Authorization: Bearer ${HIDDEN}`],
  ];
  for (const [text, shown] of said) expect(answerText(text)).toBe(shown);
  // Keys with a known prefix, signed tokens and private key blocks, as before.
  for (const secret of [
    OPENAI_KEY,
    'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
    'xoxb-1234567890-abcdefghij',
    'AKIAIOSFODNN7EXAMPLE',
    SIGNED,
  ])
    expect(answerText(`Here: ${secret} done`)).toBe(`Here: ${HIDDEN} done`);
  expect(
    answerText('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\n-----END PRIVATE KEY-----'),
  ).not.toContain('MIIEvQ');
});

test('only the secret is hidden; the words around it stay', () => {
  expect(answerText(`Your key is ${OPENAI_KEY}, keep it safe.`)).toBe(
    `Your key is ${HIDDEN}, keep it safe.`,
  );
  expect(answerText(`Use FIREWORKS_API_KEY=${FIREWORKS_KEY} in model.env.`)).toBe(
    `Use FIREWORKS_API_KEY=${HIDDEN} in model.env.`,
  );
  expect(answerText('Send Authorization: Bearer abcdefghijklmnop with it.')).toBe(
    `Send Authorization: Bearer ${HIDDEN} with it.`,
  );
  expect(answerText(`The capability was ${SIGNED}.`)).toBe(`The capability was ${HIDDEN}.`);
  expect(answerText(`Approved for payload ${HASH}.`)).toBe(`Approved for payload ${HIDDEN}.`);
  expect(answerText('Connect with postgres://app:s3cretPass@db.example.com/app')).toBe(
    `Connect with postgres://app:${HIDDEN}@db.example.com/app`,
  );
  expect(answerText('The password: hunter22 works.')).toBe(`The password: ${HIDDEN} works.`);
  expect(answerText('I queued act_01K6Z8Q4M2N7P3R5S9T1V6W8XY for you.')).toBe(
    `I queued ${HIDDEN} for you.`,
  );
  expect(
    answerText(
      '```\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n```',
    ),
  ).toBe(`\`\`\`\n-----BEGIN PRIVATE KEY-----${HIDDEN}-----END PRIVATE KEY-----\n\`\`\``);
  // A key inside a code block is still a key.
  expect(answerText(`\`\`\`bash\nexport OPENAI_API_KEY="${OPENAI_KEY}"\n\`\`\``)).toBe(
    `\`\`\`bash\nexport OPENAI_API_KEY="${HIDDEN}"\n\`\`\``,
  );
});

test('a whole internal record is taken out, and only it', () => {
  expect(answerText('{"tool":"email.send","to":"a@b.c"}')).toBe('');
  expect(
    answerText(
      'Let me check your calendar.\n\n{"name": "calendar.list", "arguments": {"from": "today"}}\n\nYou have two meetings.',
    ),
  ).toBe('Let me check your calendar.\n\n\n\nYou have two meetings.');
  expect(answerText('[{"type": "function", "function": {"name": "web.fetch"}}]')).toBe('');
});

/** Answers with something to hide, for the streaming checks. */
const HIDING = [
  `Here is your key: ${OPENAI_KEY} and the other one ${FIREWORKS_KEY}.`,
  `Header: Authorization: Bearer ${SIGNED}\nThen call it again.`,
  `Checking.{"tool_call": {"name": "email.search", "arguments": {"q": "invoice"}}} Found three invoices from ${'billing@example.com'}.`,
  `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7Yq\nQm9yZQ==\n-----END RSA PRIVATE KEY-----\nThat is the key you pasted; rotate it.`,
  `password = "Tr0ub4dor&3x" in the old file, and approval hash ${HASH}.`,
];

/** A seeded generator, so a failure names the cuts that caused it. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function chunk(text: string, next: () => number): string[] {
  const pieces: string[] = [];
  let at = 0;
  while (at < text.length) {
    const size = 1 + Math.floor(next() * (next() < 0.3 ? 3 : 24));
    pieces.push(text.slice(at, at + size));
    at += size;
  }
  return pieces;
}

test('streamed pieces always add up to the filtered saved answer', () => {
  for (const [index, answer] of [...KEPT, ...HIDING, LONG].entries())
    for (let round = 0; round < 100; round++) {
      const pieces = chunk(answer, random(index * 1000 + round));
      const stream = new AnswerStream();
      const shown = pieces.map((piece) => stream.push(piece));
      shown.push(stream.end());
      expect({ pieces, joined: shown.join('') }).toEqual({ pieces, joined: answerText(answer) });
      // Nothing secret is ever on screen, even partway through.
      for (const secret of [OPENAI_KEY, FIREWORKS_KEY, SIGNED, HASH, 'Tr0ub4dor', 'Qm9yZQ'])
        if (answer.includes(secret)) expect(shown.join('')).not.toContain(secret.slice(0, 12));
    }
});

test('a key cut across pieces is never shown, not even its start', () => {
  const stream = new AnswerStream();
  const shown = [
    stream.push('Your key is sk-proj-Q7v'),
    stream.push('Lm2Xr9TbW4kZp8NcY3dHs and it'),
    stream.push(' works.'),
  ];
  shown.push(stream.end());
  expect(shown).toEqual(['Your key is ', `${HIDDEN} and `, 'it ', 'works.']);
});

test('the Nova answer streams whole, its last word held only until the end', () => {
  const stream = new AnswerStream();
  const shown = [
    stream.push("I'm Nova. Running on `accounts"),
    stream.push('/fireworks/models/deepseek-v4p1-flash`.'),
  ];
  shown.push(stream.end());
  expect(shown).toEqual([
    "I'm Nova. Running on ",
    '',
    '`accounts/fireworks/models/deepseek-v4p1-flash`.',
  ]);
  expect(shown.join('')).toBe(NOVA);
});

test('the shown part of an unfinished answer only grows', () => {
  for (const answer of HIDING) {
    let before = '';
    for (let end = 1; end <= answer.length; end++) {
      const now = answerStream(answer.slice(0, end));
      expect(now.startsWith(before)).toBe(true);
      before = now;
    }
  }
});

test('the long answer keeps its code and table and hides only the key and the record', () => {
  const shown = answerText(LONG);
  expect(shown).toContain('accounts/fireworks/models/deepseek-v4p1-flash');
  expect(shown).toContain('registry.example.com/app:59');
  expect(shown).toContain(`api_key: "${HIDDEN}"`);
  expect(shown).toContain('Then  and done.');
  expect(shown).not.toContain('A1b2C3d4');
});

test('a long answer streams in time that grows with its length, not its square', () => {
  const answer = Array.from({ length: 12 }, () => LONG).join('\n\n');
  expect(answer.length).toBeGreaterThan(60_000);
  const started = performance.now();
  const stream = new AnswerStream();
  const shown: string[] = [];
  for (let at = 0; at < answer.length; at += 4) shown.push(stream.push(answer.slice(at, at + 4)));
  shown.push(stream.end());
  expect(performance.now() - started).toBeLessThan(5_000);
  expect(shown.join('')).toBe(answerText(answer));
});

test('a file named after a record id is a file name, while a bare record id stays hidden', () => {
  expect(answerText('Saved act_01M3W8C7DPW288T2ZC2Z1JCYN8.png to the desktop.')).toBe(
    'Saved act_01M3W8C7DPW288T2ZC2Z1JCYN8.png to the desktop.',
  );
  expect(answerText('It is at /work/shots/act_01M3W8C7DPW288T2ZC2Z1JCYN8 now.')).toBe(
    'It is at /work/shots/act_01M3W8C7DPW288T2ZC2Z1JCYN8 now.',
  );
  // A record id that ends a sentence is still a record id.
  expect(answerText('I queued act_01K6Z8Q4M2N7P3R5S9T1V6W8XY.')).toBe(`I queued ${HIDDEN}.`);
  expect(answerText(`Use ${OPENAI_KEY}.png as the key.`)).toBe(`Use ${HIDDEN}.png as the key.`);
});
