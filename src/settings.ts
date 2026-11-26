// Non-secret preferences, kept in localStorage (no notes or keys are ever stored in the browser).
const SETTINGS_KEY = 'cherrion_settings_v1';

export interface Settings {
  dark: boolean;
  /** 0 means never. */
  autoLockMinutes: number;
  /** Last account username, to pre-fill the login form. */
  accountName: string;
  /** Display name for the login greeting; the synced source of truth is the encrypted profile. */
  userName: string;
}

export const AUTO_LOCK_CHOICES = [1, 5, 10, 30, 60, 0] as const;
const DEFAULTS: Settings = { dark: false, autoLockMinutes: 10, accountName: '', userName: '' };

function load(): Settings {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return { ...DEFAULTS };
    const r = raw as Partial<Settings>;
    return {
      dark: r.dark === true,
      autoLockMinutes: (AUTO_LOCK_CHOICES as readonly number[]).includes(r.autoLockMinutes as number)
        ? (r.autoLockMinutes as number) : DEFAULTS.autoLockMinutes,
      accountName: typeof r.accountName === 'string' ? r.accountName.slice(0, 40) : DEFAULTS.accountName,
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
