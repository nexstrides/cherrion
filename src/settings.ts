// Non-secret preferences, kept in localStorage.
const SETTINGS_KEY = 'cherrion_settings_v1';

export interface Settings {
  syncUrl: string;
  syncKey: string;
  dark: boolean;
  /** 0 means never. */
  autoLockMinutes: number;
  /**
   * Device-local copy of the vault's user name, for the lock-screen greeting and password-manager
   * autofill. The synced source of truth is the encrypted profile in the vault header.
   */
  userName: string;
}

export const AUTO_LOCK_CHOICES = [1, 5, 10, 30, 60, 0] as const;
const DEFAULTS: Settings = { syncUrl: '', syncKey: 'my-personal-notes', dark: false, autoLockMinutes: 10, userName: '' };

function load(): Settings {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return { ...DEFAULTS };
    const r = raw as Partial<Settings>;
    return {
      syncUrl: typeof r.syncUrl === 'string' ? r.syncUrl : DEFAULTS.syncUrl,
      syncKey: typeof r.syncKey === 'string' && r.syncKey ? r.syncKey : DEFAULTS.syncKey,
      dark: r.dark === true,
      autoLockMinutes: (AUTO_LOCK_CHOICES as readonly number[]).includes(r.autoLockMinutes as number)
        ? (r.autoLockMinutes as number) : DEFAULTS.autoLockMinutes,
      userName: typeof r.userName === 'string' ? r.userName.slice(0, 60) : DEFAULTS.userName,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings: Settings = load();

export function saveSettings(): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}
