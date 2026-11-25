import type { CategoryId } from '../model';

export const ui = {
  activeNoteId: null as string | null,
  activeTab: 'tree' as 'tree' | 'stickies',
  search: '',
  category: 'all' as CategoryId | 'all',
  /** Field ids whose secret value is currently shown. Cleared on note switch and on lock. */
  revealed: new Set<string>(),
  /** 2FA fields whose secret key is open for editing (instead of showing the code). */
  editing: new Set<string>(),
};

/** Render entry points, filled in by app.ts. Kept here so modules can re-render without import cycles. */
export const render = {
  all: (): void => {},
  tree: (): void => {},
  editor: (): void => {},
  stickies: (): void => {},
};

/** Shell hooks filled in by app.ts (the slide-in sidebar on narrow screens). */
export const shell = {
  closeNav: (): void => {},
  /** Filled in by lock.ts (locks this and every other open tab). */
  lock: (): void => {},
};

export function selectNote(id: string | null): void {
  if (ui.activeNoteId !== id) { ui.revealed.clear(); ui.editing.clear(); }
  ui.activeNoteId = id;
}

let lastActivity = Date.now();
export const markActivity = (): void => { lastActivity = Date.now(); };
export const idleFor = (): number => Date.now() - lastActivity;
