import { afterEach, describe, expect, it } from 'vitest';
import { api, ApiError, setReauthenticator, setSession, setTransport, type Transport } from '../src/api';

const header = {
  format: 'cherrion-vault', v: 1, vaultId: 'v', createdAt: 1, updatedAt: 1,
  kdf: { alg: 'argon2id13', opslimit: 1, memlimit: 8192, salt: 'c2FsdHNhbHRzYWx0c2FsdA' },
  passwordWrap: { nonce: 'n', ct: 'c' }, recoveryWrap: { nonce: 'n', ct: 'c' }, mac: 'm',
};

afterEach(() => { setReauthenticator(null); setSession(null); });

/** A fake server: sync accepts only the token "fresh". */
function fakeServer(log: string[]): Transport {
  return async (path, _body, token) => {
    log.push(`${path}:${token ?? '-'}`);
    if (path === 'sync') return token === 'fresh' ? { status: 200, data: { notes: [], rev: 7, more: false, header } } : { status: 401, data: { error: 'Your session has expired. Please log in again.' } };
    return { status: 404, data: {} };
  };
}

describe('session renewal', () => {
  it('renews an expired session once and retries the request', async () => {
    const log: string[] = [];
    setTransport(fakeServer(log));
    setSession('stale');
    let renewals = 0;
    setReauthenticator(async () => { renewals++; setSession('fresh'); return true; });
    const res = await api.sync({ since: 0, notes: [] });
    expect(res.rev).toBe(7);
    expect(renewals).toBe(1);
    expect(log).toEqual(['sync:stale', 'sync:fresh']);
  });

  it('shares one renewal between requests that fail together', async () => {
    setTransport(fakeServer([]));
    setSession('stale');
    let renewals = 0;
    setReauthenticator(async () => { renewals++; await new Promise(r => setTimeout(r, 20)); setSession('fresh'); return true; });
    await Promise.all([api.sync({ since: 0, notes: [] }), api.sync({ since: 0, notes: [] }), api.sync({ since: 0, notes: [] })]);
    expect(renewals).toBe(1);
  });

  it('reports the expiry when renewal is not possible', async () => {
    setTransport(fakeServer([]));
    setSession('stale');
    setReauthenticator(async () => false);
    await expect(api.sync({ since: 0, notes: [] })).rejects.toMatchObject({ status: 401 });
    setReauthenticator(null);
    const err = await api.sync({ since: 0, notes: [] }).catch(e => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
  });
});
