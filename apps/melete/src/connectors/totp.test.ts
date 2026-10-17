import { describe, expect, test } from 'bun:test';
import {
  base32Decode,
  base32Encode,
  currentCode,
  hotp,
  parseTotpInput,
  sealableTotp,
  type TotpAlgorithm,
  TotpInvalid,
  totpAt,
  totpFromSealed,
  verifyTotp,
} from './totp.ts';

const ascii = (text: string) => new TextEncoder().encode(text);
/** The seeds RFC 6238's Appendix B uses for each hash. */
const SEEDS: Record<TotpAlgorithm, Uint8Array> = {
  SHA1: ascii('12345678901234567890'),
  SHA256: ascii('12345678901234567890123456789012'),
  SHA512: ascii('1234567890123456789012345678901234567890123456789012345678901234'),
};

describe('one-time codes', () => {
  test('HOTP matches the RFC 4226 Appendix D values', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expect(expected.map((_, counter) => hotp(SEEDS.SHA1, counter, 6))).toEqual(expected);
  });

  test('TOTP matches every RFC 6238 Appendix B value, for each hash', () => {
    const vectors: Array<[number, string, TotpAlgorithm]> = [
      [59, '94287082', 'SHA1'],
      [59, '46119246', 'SHA256'],
      [59, '90693936', 'SHA512'],
      [1111111109, '07081804', 'SHA1'],
      [1111111109, '68084774', 'SHA256'],
      [1111111109, '25091201', 'SHA512'],
      [1111111111, '14050471', 'SHA1'],
      [1111111111, '67062674', 'SHA256'],
      [1111111111, '99943326', 'SHA512'],
      [1234567890, '89005924', 'SHA1'],
      [1234567890, '91819424', 'SHA256'],
      [1234567890, '93441116', 'SHA512'],
      [2000000000, '69279037', 'SHA1'],
      [2000000000, '90698825', 'SHA256'],
      [2000000000, '38618901', 'SHA512'],
      [20000000000, '65353130', 'SHA1'],
      [20000000000, '77737706', 'SHA256'],
      [20000000000, '47863826', 'SHA512'],
    ];
    for (const [seconds, code, algorithm] of vectors)
      expect([
        seconds,
        algorithm,
        totpAt({ secret: SEEDS[algorithm], algorithm, digits: 8, period: 30 }, seconds * 1000),
      ]).toEqual([seconds, algorithm, code]);
  });

  test('six digits are the last six of the same value', () => {
    const config = {
      secret: SEEDS.SHA1,
      algorithm: 'SHA1' as const,
      digits: 6 as const,
      period: 30,
    };
    expect(totpAt(config, 59_000)).toBe('287082');
    expect(totpAt(config, 1111111109_000)).toBe('081804');
  });

  test('a code is accepted one step either side of now, and not two', () => {
    const config = {
      secret: SEEDS.SHA1,
      algorithm: 'SHA1' as const,
      digits: 8 as const,
      period: 30,
    };
    const at = 1111111111_000;
    const before = totpAt(config, at - 30_000);
    const after = totpAt(config, at + 30_000);
    const far = totpAt(config, at + 60_000);
    expect(verifyTotp(config, totpAt(config, at), at)).toBe(true);
    expect(verifyTotp(config, before, at)).toBe(true);
    expect(verifyTotp(config, after, at)).toBe(true);
    expect(verifyTotp(config, far, at)).toBe(false);
    expect(verifyTotp(config, far, at, 2)).toBe(true);
    expect(verifyTotp(config, '1234567', at)).toBe(false);
    expect(verifyTotp(config, 'abcdefgh', at)).toBe(false);
  });

  test('the current code says how long it has left', () => {
    const config = {
      secret: SEEDS.SHA1,
      algorithm: 'SHA1' as const,
      digits: 6 as const,
      period: 30,
    };
    expect(currentCode(config, 59_000)).toEqual({ code: '287082', expires_in: 1 });
    expect(currentCode(config, 30_000).expires_in).toBe(30);
  });
});

describe('code secrets and otpauth links', () => {
  test('base32 round-trips and forgives case, spaces and padding', () => {
    const secret = base32Encode(SEEDS.SHA1);
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(secret.toLowerCase().replace(/(.{4})/g, '$1 '))).toEqual(SEEDS.SHA1);
    expect(base32Decode('MZXW6===')).toEqual(ascii('foo'));
    expect(() => base32Decode('MZXW1')).toThrow(TotpInvalid);
  });

  test('a bare secret is read as the common default: SHA1, six digits, thirty seconds', () => {
    const config = parseTotpInput(' gezd gnbv gy3t qojq gezd gnbv gy3t qojq ');
    expect(config).toEqual({ secret: SEEDS.SHA1, algorithm: 'SHA1', digits: 6, period: 30 });
  });

  test('an otpauth link carries its hash, digits and period', () => {
    const secret = base32Encode(SEEDS.SHA256);
    const config = parseTotpInput(
      `otpauth://totp/Example:alice@example.com?secret=${secret}&issuer=Example&algorithm=SHA256&digits=8&period=60`,
    );
    expect(config.algorithm).toBe('SHA256');
    expect(config.digits).toBe(8);
    expect(config.period).toBe(60);
    expect(config.secret).toEqual(SEEDS.SHA256);
    expect(parseTotpInput(`otpauth://totp/x?secret=${base32Encode(SEEDS.SHA1)}`).digits).toBe(6);
  });

  test('links it cannot honour are refused in words that never repeat the secret', () => {
    const secret = base32Encode(SEEDS.SHA1);
    const refusals = [
      `otpauth://hotp/x?secret=${secret}&counter=1`,
      `otpauth://totp/x?secret=${secret}&algorithm=MD5`,
      `otpauth://totp/x?secret=${secret}&digits=10`,
      `otpauth://totp/x?secret=${secret}&period=1`,
      'otpauth://totp/x?issuer=Example',
      'otpauth://totp/x?secret=GEZDGNBV',
      'not base32!',
    ];
    for (const input of refusals) {
      let message = '';
      try {
        parseTotpInput(input);
      } catch (error) {
        expect(error).toBeInstanceOf(TotpInvalid);
        message = (error as Error).message;
      }
      expect([input, message.length > 0, message.includes(secret)]).toEqual([input, true, false]);
    }
  });

  test('what is sealed opens to the same codes', () => {
    const config = parseTotpInput(
      `otpauth://totp/x?secret=${base32Encode(SEEDS.SHA512)}&algorithm=SHA512&digits=8`,
    );
    const reopened = totpFromSealed(sealableTotp(config));
    expect(totpAt(reopened, 2000000000_000)).toBe('38618901');
  });
});
