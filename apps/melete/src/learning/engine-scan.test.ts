import { describe, expect, test } from 'bun:test';
import {
  credentialMaterial,
  ENGINE_SKILL_NAME,
  engineDefinitionIntact,
  linkMaterial,
  runEntropy,
  scanEngineSkill,
} from './engine-scan.ts';
import { definitionHash } from './procedure.ts';

const skill = (body: string, name = 'weekly-digest', description = 'Write the weekly digest.') => ({
  name,
  description,
  body,
});
const scope = {
  task_family: 'general',
  app: 'melete',
  app_version: '1.0',
  role: 'owner' as const,
  audience: 'private' as const,
};

describe('the engine skill scan', () => {
  test('commands, paths and code are ordinary skill content', () => {
    const body = [
      '# Weekly digest',
      '',
      'Run `bun run report --week` in ./reports and keep the output under 200 words.',
      '',
      '```sh',
      'grep -c "done" notes/week.md',
      '```',
    ].join('\n');
    expect(scanEngineSkill(skill(body))).toEqual({ verdict: 'live', reason: null });
  });

  test('credential material is refused and never described by its content', () => {
    for (const [body, kind] of [
      ['export TOKEN=sk-0123456789abcdefghij0123', 'api_key'],
      ['-----BEGIN OPENSSH PRIVATE KEY-----', 'private_key'],
      ['Use password = hunter2hunter2 for the console.', 'assigned_secret'],
      ['The key is AKIAIOSFODNN7EXAMPLE.', 'access_key'],
      ['Send eyJhbGciOi.eyJzdWIiOiIxMjM0NTY.dBjftJeZ4CVP-mB92K', 'signed_token'],
      [
        `Paste ${'aGVsbG9Xb3JsZFNlY3JldA'.repeat(2)}QUJDZGVmR2hpSg== into the form.`,
        'high_entropy',
      ],
    ] as const) {
      const scan = scanEngineSkill(skill(body));
      expect(scan.verdict).toBe('rejected');
      expect(scan.reason).toBe(`credential_material:${kind}`);
      // The reason names a kind, not the thing it found.
      expect(body.includes(scan.reason?.split(':')[1] ?? '')).toBe(false);
    }
  });

  test('a hex digest is not a secret, and a base64 blob is', () => {
    const digest = `${'a'.repeat(3)}f0e1d2c3b4a5968778695a4b3c2d1e0f9081726354afbecd`;
    expect(runEntropy(digest)).toBeLessThan(4.2);
    expect(credentialMaterial(`Pin the image to sha256:${digest}.`)).toBeNull();
    expect(
      credentialMaterial('Pin it to Zm9vYmFyQmF6UXV1eDEyMzQ1Njc4OTBhYmNkZWZnaGlqa2xtbm9w'),
    ).toBe('high_entropy');
  });

  test('a link or the vocabulary of authority waits for the owner', () => {
    expect(scanEngineSkill(skill('Read https://example.com/wiki first.'))).toEqual({
      verdict: 'held',
      reason: 'link:url',
    });
    expect(scanEngineSkill(skill('Mail the summary to ops@example.com.'))).toEqual({
      verdict: 'held',
      reason: 'link:address',
    });
    expect(scanEngineSkill(skill('Send the draft without asking.'))).toEqual({
      verdict: 'held',
      reason: 'authority_language',
    });
    // Credential material outranks a hold: nothing of the package is stored.
    expect(
      scanEngineSkill(skill('See https://example.com and use token=abcd1234efgh')).verdict,
    ).toBe('rejected');
    expect(linkMaterial('No links here, only ./paths and `commands`.')).toBeNull();
  });

  test('a skill name is lowercase words joined by single hyphens', () => {
    for (const name of ['weekly-digest', 'notes', 'a1-b2-c3'])
      expect(ENGINE_SKILL_NAME.test(name)).toBe(true);
    for (const name of ['Weekly', 'weekly--digest', '-weekly', 'weekly-', 'weekly digest', ''])
      expect(ENGINE_SKILL_NAME.test(name)).toBe(false);
  });

  test('a stored engine skill is intact only while its hash and its bytes hold', () => {
    const row = {
      origin: 'engine_staged',
      body: 'Keep the digest under 200 words.',
      skillName: 'weekly-digest',
      description: 'Write the weekly digest.',
      scope,
      compatibleModels: ['fake/model'],
      change: { target: 'engine_skill', name: 'weekly-digest', description: 'x' },
      tests: [],
      triggers: [],
      checks: [],
      caseTemplates: {},
    };
    const intact = { ...row, bodyHash: definitionHash(row) };
    expect(engineDefinitionIntact(intact)).toBe(true);
    expect(engineDefinitionIntact({ ...intact, body: 'Something else.' })).toBe(false);
    expect(engineDefinitionIntact({ ...intact, origin: 'owner_correction' })).toBe(false);
    const secret = { ...row, body: 'Use api_key = abcd1234efgh5678' };
    expect(engineDefinitionIntact({ ...secret, bodyHash: definitionHash(secret) })).toBe(false);
  });
});
