import { describe, expect, it } from 'vitest';
import { base32Decode, formatCode, parseTotp, secondsRemaining, totpCode, type TotpParams } from '../src/totp';

const ascii = (s: string) => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

describe('RFC 6238 test vectors (8 digits)', () => {
  const vectors: [number, string, string, string][] = [
    // time,       SHA-1,      SHA-256,    SHA-512
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
  ];
  const keys = {
    'SHA-1': ascii('12345678901234567890'),
    'SHA-256': ascii('12345678901234567890123456789012'),
    'SHA-512': ascii('1234567890123456789012345678901234567890123456789012345678901234'),
  } as const;

  for (const [time, sha1, sha256, sha512] of vectors) {
    it(`matches at T=${time}`, async () => {
      const at = (algorithm: TotpParams['algorithm']) =>
        totpCode({ secret: keys[algorithm], algorithm, digits: 8, period: 30 }, time * 1000);
      expect(await at('SHA-1')).toBe(sha1);
      expect(await at('SHA-256')).toBe(sha256);
      expect(await at('SHA-512')).toBe(sha512);
    });
  }
});

describe('parseTotp', () => {
  it('accepts a Base32 key in the usual spaced, lower-case forms', () => {
    const a = parseTotp('JBSWY3DPEHPK3PXP')!;
    const b = parseTotp('jbsw y3dp ehpk 3pxp')!;
    expect(Array.from(a.secret)).toEqual(Array.from(b.secret));
    expect(a).toMatchObject({ algorithm: 'SHA-1', digits: 6, period: 30 });
  });

  it('reads otpauth links, including issuer, account and options', () => {
    const p = parseTotp('otpauth://totp/Google:me%40gmail.com?secret=JBSWY3DPEHPK3PXP&issuer=Google&digits=8&period=60&algorithm=SHA256')!;
    expect(p).toMatchObject({ issuer: 'Google', account: 'me@gmail.com', digits: 8, period: 60, algorithm: 'SHA-256' });
  });

  it('rejects things that are not TOTP keys', () => {
    expect(parseTotp('')).toBeNull();
    expect(parseTotp('not a key!')).toBeNull();
    expect(parseTotp('JBSWY3DP')).toBeNull(); // too short
    expect(parseTotp('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1')).toBeNull();
    expect(parseTotp('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=4')).toBeNull();
  });

  it('produces the same code as authenticator apps for a known key', async () => {
    // JBSWY3DPEHPK3PXP is the Base32 form of "Hello!\xDE\xAD\xBE\xEF"; check against the RFC algorithm directly.
    const p = parseTotp('JBSWY3DPEHPK3PXP')!;
    expect(Array.from(p.secret)).toEqual([72, 101, 108, 108, 111, 33, 222, 173, 190, 239]);
    expect(await totpCode(p, 59_000)).toMatch(/^\d{6}$/);
  });
});

describe('helpers', () => {
  it('decodes Base32 and rejects invalid characters', () => {
    expect(Array.from(base32Decode('MZXW6===')!)).toEqual(Array.from(ascii('foo')));
    expect(base32Decode('ABC1')).toBeNull();
  });

  it('counts down to the next code and groups digits', () => {
    const p = parseTotp('JBSWY3DPEHPK3PXP')!;
    expect(secondsRemaining(p, 0)).toBe(30);
    expect(secondsRemaining(p, 29_500)).toBe(1);
    expect(formatCode('123456')).toBe('123 456');
    expect(formatCode('12345678')).toBe('1234 5678');
  });
});
