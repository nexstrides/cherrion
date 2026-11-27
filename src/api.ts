// Client for the Cherrion API (api/ on Vercel). Everything sent is either ciphertext, a key-wrapped
// vault header, or a one-way auth key; the session token lives only in memory.
import type { KdfParams } from './crypto';
import { toB64 } from './crypto';
import type { Envelope } from './envelope';
import { isEnvelope, isKdfParams, isVaultHeader } from './shapes';
import type { VaultHeader } from './vault';

export class ApiError extends Error {
  /** 0 means the server could not be reached (offline). */
  constructor(message: string, readonly status: number) { super(message); this.name = 'ApiError'; }
}

let token: string | null = null;
export const setSession = (t: string | null): void => { token = t; };
export const hasSession = (): boolean => token !== null;

/** Sends one request; status 0 means the server could not be reached. */
export type Transport = (path: string, body: string, token: string | null) => Promise<{ status: number; data: Record<string, unknown> }>;

/** The web build: same-origin /api on Vercel. */
const fetchTransport: Transport = async (path, body, auth) => {
  let res: Response;
  try {
    res = await fetch(`/api/${path}`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      body,
    });
  } catch {
    return { status: 0, data: {} };
  }
  let data: Record<string, unknown> = {};
  try { data = (await res.json()) as Record<string, unknown>; } catch { /* non-JSON error page */ }
  return { status: res.status, data };
};

let transport: Transport = fetchTransport;
/** The desktop build sends requests through Python to the vault file's sync server. */
export const setTransport = (t: Transport): void => { transport = t; };

/**
 * Renews an expired session (sessions last 12 hours): resolves true when a new token is set. The web
 * app logs back in with the kept login key, or asks for the password; the desktop app reconnects.
 */
let reauthenticate: (() => Promise<boolean>) | null = null;
export const setReauthenticator = (fn: (() => Promise<boolean>) | null): void => { reauthenticate = fn; };
let renewing: Promise<boolean> | null = null;
/** One renewal at a time: requests that fail together wait for the same one. */
function renewSession(): Promise<boolean> {
  // Cleared by `.finally` (asynchronous), so the slot never keeps a settled promise (see desktop connect()).
  renewing ??= (async () => {
    try { return reauthenticate ? await reauthenticate() : false; } catch { return false; }
  })().finally(() => { renewing = null; });
  return renewing;
}

async function post(path: string, body: unknown, auth = false): Promise<Record<string, unknown>> {
  const text = JSON.stringify(body);
  let { status, data } = await transport(path, text, auth ? token : null);
  // Session expired: renew it quietly and try once more, so nothing waiting to be saved is lost.
  if (status === 401 && auth && path !== 'logout' && (await renewSession())) {
    ({ status, data } = await transport(path, text, token));
  }
  const message = typeof data.error === 'string' ? data.error : null;
  if (status === 0) throw new ApiError(message ?? 'Cannot reach the Cherrion server. Check your internet connection.', 0);
  if (status < 200 || status >= 300) throw new ApiError(message ?? `Server error (${status}).`, status);
  return data;
}

function header(x: unknown): VaultHeader {
  if (!isVaultHeader(x)) throw new ApiError('The server sent an invalid vault header.', 500);
  return x;
}
function session(data: Record<string, unknown>): { token: string; header: VaultHeader } {
  if (typeof data.token !== 'string') throw new ApiError('The server did not start a session.', 500);
  return { token: data.token, header: header(data.header) };
}

const b64 = (key: Uint8Array) => toB64(key);

export const api = {
  /** False when the server uses the temporary in-memory development database. */
  async persistent(): Promise<boolean> {
    try { return (await post('status', {})).persistent !== false; } catch { return true; }
  },
  async prelogin(username: string): Promise<KdfParams> {
    const { kdf } = await post('prelogin', { username });
    if (!isKdfParams(kdf)) throw new ApiError('The server sent invalid login parameters.', 500);
    return kdf;
  },
  async signup(b: { username: string; header: VaultHeader; authKey: Uint8Array; recoveryAuthKey: Uint8Array; notes: Envelope[] }) {
    return session(await post('signup', { ...b, authKey: b64(b.authKey), recoveryAuthKey: b64(b.recoveryAuthKey) }));
  },
  async login(username: string, authKey: Uint8Array) {
    return session(await post('login', { username, authKey: b64(authKey) }));
  },
  /** Checks the recovery key; returns the header to unwrap with it. */
  async recoverStart(username: string, recoveryAuthKey: Uint8Array): Promise<VaultHeader> {
    return header((await post('recover', { username, recoveryAuthKey: b64(recoveryAuthKey) })).header);
  },
  async recoverFinish(username: string, recoveryAuthKey: Uint8Array, next: VaultHeader, authKey: Uint8Array) {
    return session(await post('recover', { username, recoveryAuthKey: b64(recoveryAuthKey), header: next, authKey: b64(authKey) }));
  },
  async updateAccount(b: { currentAuthKey: Uint8Array; header: VaultHeader; authKey?: Uint8Array; recoveryAuthKey?: Uint8Array }): Promise<VaultHeader> {
    return header((await post('account', {
      currentAuthKey: b64(b.currentAuthKey),
      header: b.header,
      ...(b.authKey ? { authKey: b64(b.authKey) } : {}),
      ...(b.recoveryAuthKey ? { recoveryAuthKey: b64(b.recoveryAuthKey) } : {}),
    }, true)).header);
  },
  async sync(b: { since: number; notes: Envelope[]; header?: VaultHeader }): Promise<{ notes: Envelope[]; rev: number; more: boolean; header: VaultHeader }> {
    const data = await post('sync', b, true);
    const notes = Array.isArray(data.notes) ? data.notes.filter(isEnvelope) : [];
    return { notes, rev: typeof data.rev === 'number' ? data.rev : b.since, more: data.more === true, header: header(data.header) };
  },
  /** Shared workspaces: one endpoint with an `action` (see api/_lib/workspaces.ts). */
  async workspace(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return post('workspace', body, true);
  },
  async wsync(b: { workspaceId: string; since: number; notes: Envelope[] }): Promise<{ notes: Envelope[]; rev: number; more: boolean; epoch: number }> {
    const data = await post('wsync', b, true);
    const notes = Array.isArray(data.notes) ? data.notes.filter(isEnvelope) : [];
    return { notes, rev: typeof data.rev === 'number' ? data.rev : b.since, more: data.more === true, epoch: typeof data.epoch === 'number' ? data.epoch : 1 };
  },
  /**
   * Account help (api/_lib/admin.ts), on the account endpoint (Vercel's free plan allows 12 functions):
   * recovery requests, reset codes, owner recovery.
   */
  async support(body: Record<string, unknown>, authed = false): Promise<Record<string, unknown>> {
    return post('account', body, authed);
  },
  /** Starts again with a new, empty vault, using a reset code from the owner. */
  async resetWithCode(b: { username: string; code: string; header: VaultHeader; authKey: Uint8Array; recoveryAuthKey: Uint8Array }) {
    return session(await post('account', { action: 'reset', ...b, authKey: b64(b.authKey), recoveryAuthKey: b64(b.recoveryAuthKey) }));
  },
  /** Attached files' encrypted chunks (see api/_lib/files.ts). */
  async file(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return post('file', body, true);
  },
  async logout(): Promise<void> {
    if (!token) return;
    try { await post('logout', {}, true); } catch { /* best effort */ }
  },
};
