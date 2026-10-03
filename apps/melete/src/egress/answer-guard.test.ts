import { describe, expect, test } from 'bun:test';
import { credentialInAnswer, credentialInText } from './answer-guard.ts';

describe('the answer guard', () => {
  test('bearer tokens, passwords and keys in any shape are found, and paging tokens are not', () => {
    const found = (text: string) => credentialInText(text);
    // An approved SSO token exchange answers with tokens of its own.
    expect(
      found('{"accessToken":"eyJ","tokenType":"Bearer","refreshToken":"r1","idToken":"i1"}'),
    ).toBe('an access token');
    expect(found('{"refresh_token":"r1"}')).toBe('a refresh token');
    expect(found('{"IdToken":"i1"}')).toBe('an identity token');
    expect(found('<authorizationToken>QVdTOnRva2Vu</authorizationToken>')).toBe(
      'an authorization token',
    );
    expect(found('{"authorizationData":[{"authorizationToken":"QVdT"}]}')).toBe(
      'an authorization token',
    );
    expect(found('<DbPassword>hunter2</DbPassword>')).toBe('a password');
    expect(found('{"masterUserPassword":"p"}')).toBe('a password');
    expect(found('{"Credentials":{"UserName":"u","Secret":"s"}}')).toBe('a secret');
    expect(found('{"client_secret":"c"}')).toBe('a client secret');
    expect(found('access_token=abc&token_type=bearer')).toBe('an access token');
    expect(found('<SessionToken>t</SessionToken>')).toBe('a session token');
    expect(found('-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl')).toBe('a private key');
    // Paging and retry tokens, empty values and password rules are not credentials.
    for (const ordinary of [
      '{"NextToken":"abc","Users":[]}',
      '<NextToken>abc</NextToken><ClientToken>uuid</ClientToken>',
      '{"nextToken":"x","continuationToken":"y","idempotencyToken":"z"}',
      '{"accessToken":"","refreshToken":null}',
      '<PasswordPolicy><MinimumPasswordLength>12</MinimumPasswordLength></PasswordPolicy>',
      '{"PasswordLastUsed":"2026-10-01"}',
    ])
      expect([ordinary, found(ordinary)]).toEqual([ordinary, null]);
  });

  test('a header holding a token is found too', () => {
    expect(
      credentialInAnswer({ body: Buffer.from('{}'), headers: { 'x-access-token': 'abc' } }),
    ).toBe('an access token');
    expect(credentialInAnswer({ body: Buffer.from('{}'), headers: { etag: '"1"' } })).toBeNull();
  });
});
