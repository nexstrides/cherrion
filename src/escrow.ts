// Owner recovery (opt-in "escrow"): the vault key is also sealed to the public key of this server's
// owner, so the owner can make a new recovery key for someone who lost both their password and their
// recovery key. Off unless the person turns it on in Settings; the server only stores the sealed key.
import { api } from './api';
import { fingerprint, fromB64 } from './crypto';
import * as store from './store';

export interface EscrowStatus {
  /** The server has an owner (admin) key. */
  available: boolean;
  adminKey: string | null;
  enabled: boolean;
  /** Sealed to the owner's current key (false after the owner changed keys). */
  current: boolean;
}

function parse(d: Record<string, unknown>): EscrowStatus {
  return {
    available: d.available === true,
    adminKey: typeof d.adminKey === 'string' ? d.adminKey : null,
    enabled: d.enabled === true,
    current: d.current === true,
  };
}

export async function escrowStatus(): Promise<EscrowStatus> {
  return parse(await api.support({ action: 'escrow', op: 'status' }, true));
}

export async function enableEscrow(adminKey: string): Promise<EscrowStatus> {
  const sealed = store.sealVaultKeyTo(fromB64(adminKey));
  return parse(await api.support({ action: 'escrow', op: 'enable', adminKey, sealed }, true));
}

export async function disableEscrow(): Promise<EscrowStatus> {
  return parse(await api.support({ action: 'escrow', op: 'disable' }, true));
}

/** After the owner replaced their key, re-seal for the new one (once per session, from sync). */
export async function keepEscrowCurrent(): Promise<void> {
  const s = await escrowStatus();
  if (s.enabled && !s.current && s.available && s.adminKey) await enableEscrow(s.adminKey);
}

/** A short code for the owner key, to compare with what the owner sees in their dashboard. */
export const ownerKeyCode = (adminKey: string): string =>
  fingerprint(fromB64(adminKey)).slice(0, 16).toUpperCase().match(/.{4}/g)!.join(' ');
