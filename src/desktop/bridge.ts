// Typed access to the Python side of the desktop app (desktop/cherrion_desktop/app.py, class Api).
// pywebview injects window.pywebview.api once the page has loaded and fires `pywebviewready`.
import type { Sealed } from '../crypto';
import type { Envelope } from '../envelope';
import type { VaultHeader } from '../vault';

export interface FileSync { url: string; username: string; since: number }
/** Shared workspaces this account owns, kept in the file: sealed records and their pages. */
export interface KeptSpaces { spaces: { id: string; record: unknown }[]; spaceNotes: { space: string; envelope: Envelope; dirty: boolean }[] }
export interface OpenedFile {
  path: string; header: unknown; notes: unknown[]; dirty: string[]; sync: FileSync | null;
  spaces?: { id: string; record: unknown }[]; spaceNotes?: { space: string; envelope: unknown; dirty: boolean }[];
}
export interface AppInfo { version: string; recent: string[]; defaultSyncUrl: string; launchFile: string | null }
export interface FileAssociation { available: boolean; enabled: boolean }
export type CloseAction = 'ask' | 'tray' | 'exit';
export interface FileChanges {
  notes?: { envelope: Envelope; dirty: boolean }[];
  header?: VaultHeader;
  meta?: Partial<Record<'sync_url' | 'sync_username' | 'sync_since', string | number | null>>;
  spaces?: { id: string; record: Sealed }[];
  spaceNotes?: { space: string; envelope: Envelope; dirty: boolean }[];
  forgetSpaces?: string[];
}

interface PyApi {
  app_info(): Promise<AppInfo>;
  forget_recent(path: string): Promise<void>;
  clipboard_text(): Promise<string>;
  close_action(): Promise<CloseAction>;
  set_close_action(action: CloseAction): Promise<CloseAction>;
  tray_available(): Promise<boolean>;
  close_choice(choice: 'tray' | 'exit' | 'cancel', remember: boolean): Promise<void>;
  file_association(): Promise<FileAssociation>;
  set_file_association(enabled: boolean): Promise<FileAssociation>;
  pick_open(): Promise<string | null>;
  pick_save(suggested: string): Promise<string | null>;
  save_text(suggested: string, text: string): Promise<string | null>;
  save_bytes(suggested: string, base64url: string): Promise<string | null>;
  vault_create(path: string, header: VaultHeader, notes: Envelope[], sync: FileSync | null): Promise<{ path: string }>;
  vault_open(path: string): Promise<OpenedFile>;
  vault_save(changes: FileChanges): Promise<void>;
  vault_mark_clean(sent: [string, number][], space?: string | null): Promise<void>;
  vault_file_put(fileId: string, index: number, count: number, chunk: Sealed, uploaded: boolean): Promise<void>;
  vault_file_get(fileId: string, index: number): Promise<Sealed | null>;
  vault_file_pending(limit: number): Promise<{ fileId: string; index: number; count: number; chunk: Sealed }[]>;
  vault_file_mark_uploaded(fileId: string, index: number): Promise<void>;
  vault_file_delete(fileId: string): Promise<void>;
  vault_close(): Promise<void>;
  http_post(baseUrl: string, endpoint: string, body: string, token: string | null): Promise<{ status: number; data: Record<string, unknown> }>;
}

declare global {
  interface Window { pywebview?: { api: PyApi } }
}

let ready: Promise<PyApi> | null = null;

function waitForBridge(): Promise<PyApi> {
  ready ??= new Promise((resolve, reject) => {
    const found = () => window.pywebview?.api && typeof window.pywebview.api.vault_open === 'function';
    if (found()) { resolve(window.pywebview!.api); return; }
    const timeout = setTimeout(() => reject(new Error('The desktop bridge did not start. Run Cherrion from its app, not a browser.')), 15_000);
    window.addEventListener('pywebviewready', () => { clearTimeout(timeout); resolve(window.pywebview!.api); }, { once: true });
  });
  return ready;
}

/** Python exceptions arrive as plain objects; turn them into Errors with the Python message. */
function asError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string') {
    return new Error((err as { message: string }).message);
  }
  return new Error(String(err));
}

type Method = keyof PyApi;
export async function py<M extends Method>(method: M, ...args: Parameters<PyApi[M]>): Promise<Awaited<ReturnType<PyApi[M]>>> {
  const bridge = await waitForBridge();
  try {
    return await (bridge[method] as (...a: unknown[]) => Promise<Awaited<ReturnType<PyApi[M]>>>)(...args);
  } catch (err) {
    throw asError(err);
  }
}

export const startBridge = (): Promise<unknown> => waitForBridge();
