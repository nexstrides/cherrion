// The owner's admin dashboard and account help, end to end against the server logic (memory repo):
// admin setup and login (password + 2FA), connection history, recovery requests, owner recovery for
// users who opted in, and reset codes for everyone else.
import { beforeAll, describe, expect, it } from 'vitest';
import { adminAction, supportAction } from '../api/_lib/admin';
import * as core from '../api/_lib/core';
import { adminKeysFromPassword, createAdminSetup, openAdminKey, recoveryFromEscrow, sha256Hex } from '../src/admin/keys';
import { initCrypto, sealTo, toB64, fromB64 } from '../src/crypto';
import { parseTotp, totpCode } from '../src/totp';
import { createVault, deriveKek, recoveryAuthKey, rewrapPasswordWithAuth, authKeyFromKek, unlockWithRecoveryKey } from '../src/vault';

const FAST = { opslimit: 1, memlimit: 8192 };
const ADMIN_PASSWORD = 'owner password for tests';
const repo = core.createMemoryRepo();
let totpSecret = '';

/** A request as Vercel would pass it (with its client headers). */
const req = (token?: string, ip = '203.0.113.7') => new Request('https://cherrion.test/api/x', {
  method: 'POST',
  headers: {
    'x-forwarded-for': `${ip}, 10.0.0.1`, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
    'x-vercel-ip-country': 'PT', 'x-vercel-ip-city': 'Lisboa%20Centro', 'x-vercel-ip-country-region': '11',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
});

const code = async (offsetMs = 0) => totpCode(parseTotp(totpSecret)!, Date.now() + offsetMs);

async function adminLogin(totp: string, password = ADMIN_PASSWORD, ip?: string) {
  const { kdf } = await adminAction(repo, req(), { action: 'config' }) as { kdf: Parameters<typeof adminKeysFromPassword>[1] };
  const { authKey, wrapKey } = adminKeysFromPassword(password, kdf);
  const res = await adminAction(repo, req(undefined, ip), { action: 'login', authKey, code: totp }) as { token: string; publicKey: string; privateKey: { nonce: string; ct: string } };
  return { token: res.token, owner: openAdminKey(wrapKey, res.publicKey, res.privateKey) };
}

async function newUser(name: string, password = 'user password 1234') {
  const v = createVault(password, FAST, { userName: name });
  const res = await core.signup(repo, { username: name, header: v.header, authKey: toB64(v.authKey), recoveryAuthKey: toB64(v.recoveryAuthKey), notes: [] }, {
    ip: '198.51.100.1', userAgent: 'Cherrion-Desktop/1.3.0 (Windows 10)', country: 'US', region: 'NY', city: 'New York',
  });
  return { ...v, token: res.token, id: (await repo.findAccount(name))!.id };
}

beforeAll(async () => {
  await initCrypto();
  const setup = await createAdminSetup(ADMIN_PASSWORD, FAST);
  totpSecret = setup.totpSecret;
  process.env.CHERRION_ADMIN = setup.envValue;
});

describe('admin dashboard', () => {
  let token = '';
  let owner: ReturnType<typeof openAdminKey>;

  it('has a valid setup value', async () => {
    expect(await adminAction(repo, req(), { action: 'config' })).toMatchObject({ configured: true });
    const { authKey } = adminKeysFromPassword(ADMIN_PASSWORD, JSON.parse(Buffer.from(process.env.CHERRION_ADMIN!, 'base64url').toString()).kdf);
    expect(await sha256Hex(authKey)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('needs the password and a fresh 2FA code; a code works once', async () => {
    await expect(adminLogin(await code(), 'wrong password!!')).rejects.toMatchObject({ status: 401 });
    await expect(adminLogin('000000')).rejects.toMatchObject({ status: 401 });
    const c = await code();
    ({ token, owner } = await adminLogin(c));
    expect(token).toBeTruthy();
    await expect(adminLogin(c)).rejects.toMatchObject({ status: 401 }); // replayed
    await expect(adminAction(repo, req(), { action: 'overview' })).rejects.toMatchObject({ status: 401 }); // no token
  });

  it('locks out an address after 5 failures', async () => {
    for (let i = 0; i < 5; i++) await expect(adminLogin('111111', ADMIN_PASSWORD, '192.0.2.99')).rejects.toMatchObject({ status: expect.any(Number) });
    await expect(adminLogin(await code(30_000), ADMIN_PASSWORD, '192.0.2.99')).rejects.toMatchObject({ status: 429 });
  });

  it('lists users with last seen, place and device, and the connection history', async () => {
    const ann = await newUser('ann');
    await core.login(repo, { username: 'ann', authKey: 'x'.repeat(43) }, { ip: '198.51.100.2', userAgent: 'curl/8', country: 'FR', region: '', city: 'Paris' }).catch(() => {});
    await core.sync(repo, ann.id, { since: 0, notes: [] }, { ip: '198.51.100.3', userAgent: 'Mozilla/5.0 (Macintosh) Version/17.5 Safari/605.1.15', country: 'DE', region: 'BE', city: 'Berlin' });
    const o = await adminAction(repo, req(token), { action: 'overview' }) as { users: core.Account[] & { username: string; lastCity: string; lastIp: string }[]; events: { kind: string; username: string; city: string; ip: string }[] };
    const user = (o.users as unknown as { username: string; lastCity: string; lastIp: string; escrowKey: string | null }[]).find(u => u.username === 'ann')!;
    expect(user).toMatchObject({ lastCity: 'Berlin', lastIp: '198.51.100.3', escrowKey: null });
    const kinds = o.events.filter(e => e.username === 'ann').map(e => e.kind);
    expect(kinds).toEqual(['login_failed', 'signup']); // newest first
    expect(o.events.find(e => e.kind === 'admin_login')).toMatchObject({ ip: '203.0.113.7', city: 'Lisboa Centro' });
  });

  it('owner recovery: an opted-in user gets a new recovery key and keeps their notes', async () => {
    const bob = await newUser('bob');
    // Opt in (the browser seals the vault key to the owner key it got from the server).
    const status = await supportAction(repo, req(bob.token), { action: 'escrow', op: 'status' }) as { available: boolean; adminKey: string };
    expect(status.available).toBe(true);
    const sealed = sealTo(fromB64(status.adminKey), bob.vaultKey);
    expect(await supportAction(repo, req(bob.token), { action: 'escrow', op: 'enable', adminKey: status.adminKey, sealed })).toMatchObject({ enabled: true, current: true });
    // Lost everything: asks for help.
    await supportAction(repo, req(), { action: 'request', username: 'bob', contact: 'bob@example.com', message: 'lost both' });
    const o = await adminAction(repo, req(token), { action: 'overview' }) as { requests: { id: string; username: string; accountId: string; status: string }[] };
    const request = o.requests.find(r => r.username === 'bob')!;
    expect(request).toMatchObject({ accountId: bob.id, status: 'open' });
    // The owner's browser makes a new recovery key.
    const e = await adminAction(repo, req(token), { action: 'escrow', accountId: bob.id }) as { header: Parameters<typeof recoveryFromEscrow>[0]; escrow: { sealed: string } };
    const fresh = recoveryFromEscrow(e.header, e.escrow.sealed, owner);
    await adminAction(repo, req(token), { action: 'setRecovery', accountId: bob.id, header: fresh.header, recoveryAuthKey: fresh.recoveryAuthKey, requestId: request.id });
    // Bob resets his password with it; the same vault key opens (his notes are intact).
    const rAuth = toB64(recoveryAuthKey(fresh.recoveryKey));
    const { header } = await core.recover(repo, { username: 'bob', recoveryAuthKey: rAuth });
    const vaultKey = unlockWithRecoveryKey(header, fresh.recoveryKey);
    expect(toB64(vaultKey)).toBe(toB64(bob.vaultKey));
    const next = rewrapPasswordWithAuth(header, vaultKey, 'brand new password', FAST);
    await core.recover(repo, { username: 'bob', recoveryAuthKey: rAuth, header: next.header, authKey: toB64(next.authKey) });
    const kek = deriveKek('brand new password', next.header.kdf);
    await core.login(repo, { username: 'bob', authKey: toB64(authKeyFromKek(kek)) });
    expect((await adminAction(repo, req(token), { action: 'overview' }) as { requests: { username: string; status: string }[] }).requests.find(r => r.username === 'bob')!.status).toBe('done');
  });

  it('refuses a recovery header that changes the password slot', async () => {
    const cat = await newUser('cat');
    const status = await supportAction(repo, req(cat.token), { action: 'escrow', op: 'status' }) as { adminKey: string };
    await supportAction(repo, req(cat.token), { action: 'escrow', op: 'enable', adminKey: status.adminKey, sealed: sealTo(fromB64(status.adminKey), cat.vaultKey) });
    const e = await adminAction(repo, req(token), { action: 'escrow', accountId: cat.id }) as { header: Parameters<typeof recoveryFromEscrow>[0]; escrow: { sealed: string } };
    const tampered = rewrapPasswordWithAuth(e.header, cat.vaultKey, 'attacker password', FAST);
    await expect(adminAction(repo, req(token), { action: 'setRecovery', accountId: cat.id, header: tampered.header, recoveryAuthKey: toB64(tampered.authKey) }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('reset code: someone who did not opt in starts again with an empty vault', async () => {
    const dan = await newUser('dan');
    await repo.putNotes(dan.id, [{ id: 'n1', updatedAt: 1, deleted: false, v: 1, nonce: 'n', ct: 'c' }]);
    expect((await adminAction(repo, req(token), { action: 'escrow', accountId: dan.id }) as { escrow: unknown }).escrow).toBeNull();
    const { code: resetCode } = await adminAction(repo, req(token), { action: 'resetCode', accountId: dan.id }) as { code: string };
    expect(resetCode).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
    const v = createVault('dans new password', FAST, { userName: 'dan' });
    const body = { action: 'reset', username: 'dan', header: v.header, authKey: toB64(v.authKey), recoveryAuthKey: toB64(v.recoveryAuthKey) };
    await expect(supportAction(repo, req(), { ...body, code: 'AAAAA-BBBBB-CCCCC-DDDDD' })).rejects.toMatchObject({ status: 401 });
    const res = await supportAction(repo, req(), { ...body, code: resetCode.toLowerCase() }) as { token: string };
    expect(res.token).toBeTruthy();
    expect((await repo.notesSince(dan.id, 0, 10)).notes).toEqual([]); // old notes are gone
    await expect(core.authenticate(repo, `Bearer ${dan.token}`)).rejects.toMatchObject({ status: 401 }); // old sessions too
    await expect(supportAction(repo, req(), { ...body, code: resetCode })).rejects.toMatchObject({ status: 401 }); // works once
  });

  it('answers recovery requests the same way for unknown usernames, and limits them', async () => {
    expect(await supportAction(repo, req(undefined, '192.0.2.50'), { action: 'request', username: 'nobody-here', contact: 'x@y.z' })).toEqual({ ok: true });
    await supportAction(repo, req(undefined, '192.0.2.50'), { action: 'request', username: 'nobody-here', contact: 'x@y.z' });
    await supportAction(repo, req(undefined, '192.0.2.50'), { action: 'request', username: 'nobody-here', contact: 'x@y.z' });
    await expect(supportAction(repo, req(undefined, '192.0.2.50'), { action: 'request', username: 'nobody-here', contact: 'x@y.z' })).rejects.toMatchObject({ status: 429 });
  });

  it('logs out', async () => {
    await adminAction(repo, req(token), { action: 'logout' });
    await expect(adminAction(repo, req(token), { action: 'overview' })).rejects.toMatchObject({ status: 401 });
  });
});
