// Plaintext data model. Notes only exist in this form in memory while the vault is unlocked;
// everything persisted or synced goes through envelope.ts first.

export type StickyColor = 'yellow' | 'blue' | 'green' | 'pink' | 'purple';

/** Pop-out windows cannot load styles.css, so their colours live here. Keep in sync with --sticky-* in styles.css. */
export const STICKY_COLORS: Record<StickyColor, string> = {
  yellow: '#fff7b1',
  blue: '#cde9ff',
  green: '#d2f8d2',
  pink: '#ffd6e7',
  purple: '#e6d6ff',
};

export const TEXT_BLOCK_TYPES = ['p', 'h1', 'h2', 'todo', 'callout', 'quote', 'code'] as const;
export type TextBlockType = (typeof TEXT_BLOCK_TYPES)[number];
export interface TextBlock { id: string; type: TextBlockType; content: string; checked?: boolean }
export interface DividerBlock { id: string; type: 'divider' }

/** `totp` holds a 2FA secret key (or otpauth:// link); the editor shows its current 6-digit code. */
export const FIELD_KINDS = ['text', 'email', 'url', 'tel', 'date', 'password', 'secret-text', 'totp'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];
export interface Field { id: string; label: string; value: string; kind: FieldKind; hint?: string }
export interface FieldsBlock { id: string; type: 'fields'; fields: Field[] }
/** Link to another note (created with the "/page" command). */
export interface PageBlock { id: string; type: 'page'; pageId: string }

/** A grid of plain-text cells. `rows` is rectangular; with `header`, the first row is the header. */
export interface TableBlock { id: string; type: 'table'; header: boolean; rows: string[][] }
export const TABLE_LIMITS = { rows: 200, cols: 20, cell: 10_000 } as const;

export type Block = TextBlock | DividerBlock | FieldsBlock | PageBlock | TableBlock;

export const CATEGORY_IDS = ['note', 'email', 'login', 'secure', 'meeting'] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

export interface Note {
  id: string;
  parentId: string | null;
  title: string;
  category: CategoryId;
  collapsed: boolean;
  isSticky: boolean;
  stickyColor: StickyColor;
  updatedAt: number;
  deleted: boolean;
  blocks: Block[];
  /** Manual position among siblings (set by drag and drop). Unordered notes follow, sorted by title. */
  order?: number;
}

/** Reserved id of the vault-header record kept next to notes on the sync server. */
export const VAULT_RECORD_ID = '__vault__';

/** 64-bit random id. Uses getRandomValues, which (unlike randomUUID) also works on plain-http LAN origins. */
export function uid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export const now = (): number => Date.now();

export const isSecretKind = (kind: FieldKind): boolean => kind === 'password' || kind === 'secret-text' || kind === 'totp';
export const isTextBlock = (b: Block): b is TextBlock => (TEXT_BLOCK_TYPES as readonly string[]).includes(b.type);

export function textBlock(type: TextBlockType = 'p', content = ''): TextBlock {
  return type === 'todo' ? { id: uid(), type, content, checked: false } : { id: uid(), type, content };
}

export function field(label: string, kind: FieldKind = 'text', extra: Partial<Omit<Field, 'id'>> = {}): Field {
  return { id: uid(), label, value: '', kind, ...extra };
}

export function fieldsBlock(fields: Field[]): FieldsBlock {
  return { id: uid(), type: 'fields', fields };
}

export function tableBlock(rows = 3, cols = 3): TableBlock {
  return { id: uid(), type: 'table', header: true, rows: Array.from({ length: rows }, () => Array<string>(cols).fill('')) };
}

export const SECRET_MASK = '••••••••';

/** Lower-cased text used by sidebar search. Secret field values are deliberately excluded. */
export function searchableText(note: Note): string {
  const parts = [note.title];
  for (const b of note.blocks) {
    if (isTextBlock(b)) parts.push(b.content);
    else if (b.type === 'table') parts.push(...b.rows.flat());
    else if (b.type === 'fields') {
      for (const f of b.fields) {
        parts.push(f.label);
        if (!isSecretKind(f.kind)) parts.push(f.value);
      }
    }
  }
  return parts.join('\n').toLowerCase();
}

/** Plain-text rendering for sticky cards and pop-outs. Secret values are masked and empty fields skipped. */
export function noteToPlainText(note: Note, titleOf: (id: string) => string | undefined = () => undefined): string {
  const lines: string[] = [];
  for (const b of note.blocks) {
    if (b.type === 'divider') lines.push('———');
    else if (b.type === 'page') lines.push(`📄 ${titleOf(b.pageId) || 'Untitled'}`);
    else if (b.type === 'table') {
      for (const row of b.rows) lines.push(`| ${row.map(c => c.replace(/\s*\n\s*/g, ' ')).join(' | ')} |`);
    } else if (b.type === 'fields') {
      for (const f of b.fields) {
        if (!f.value) continue;
        lines.push(`${f.label || 'Field'}: ${isSecretKind(f.kind) ? SECRET_MASK : f.value}`);
      }
    } else if (b.type === 'todo') lines.push(`${b.checked ? '[x]' : '[ ]'} ${b.content}`);
    else lines.push(b.content);
  }
  return lines.join('\n');
}

/**
 * Sticky cards and pop-outs edit notes as plain text. That round trip only preserves
 * paragraphs and to-dos, so any other note is shown read-only there.
 */
export function isPlainTextEditable(note: Note): boolean {
  return note.blocks.every(b => b.type === 'p' || b.type === 'todo');
}

export function plainTextToBlocks(text: string): TextBlock[] {
  return text.split('\n').map(line => {
    if (line.startsWith('[x] ')) return { id: uid(), type: 'todo', checked: true, content: line.slice(4) };
    if (line.startsWith('[ ] ')) return { id: uid(), type: 'todo', checked: false, content: line.slice(4) };
    return { id: uid(), type: 'p', content: line };
  });
}

// ---- Validation of notes coming from storage, sync, backups or the legacy plaintext format ----

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const oneOf = <T extends string>(list: readonly T[], x: unknown): x is T =>
  typeof x === 'string' && (list as readonly string[]).includes(x);

function normalizeField(raw: unknown): Field | null {
  if (!isObj(raw)) return null;
  const f: Field = {
    id: str(raw.id) || uid(),
    label: str(raw.label),
    value: str(raw.value),
    kind: oneOf(FIELD_KINDS, raw.kind) ? raw.kind : 'text',
  };
  if (typeof raw.hint === 'string' && raw.hint) f.hint = raw.hint;
  return f;
}

export function normalizeBlock(raw: unknown): Block | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id) || uid();
  if (raw.type === 'divider') return { id, type: 'divider' };
  if (raw.type === 'page') return typeof raw.pageId === 'string' && raw.pageId ? { id, type: 'page', pageId: raw.pageId } : null;
  if (raw.type === 'fields') {
    const fields = Array.isArray(raw.fields) ? raw.fields.map(normalizeField).filter((f): f is Field => f !== null) : [];
    return { id, type: 'fields', fields };
  }
  if (raw.type === 'table') {
    const rows = (Array.isArray(raw.rows) ? raw.rows : []).filter(Array.isArray).slice(0, TABLE_LIMITS.rows)
      .map(r => (r as unknown[]).slice(0, TABLE_LIMITS.cols).map(c => str(c).slice(0, TABLE_LIMITS.cell)));
    const cols = Math.max(1, ...rows.map(r => r.length));
    const grid = rows.length ? rows.map(r => [...r, ...Array<string>(cols - r.length).fill('')]) : [['']];
    return { id, type: 'table', header: raw.header === true, rows: grid };
  }
  if (oneOf(TEXT_BLOCK_TYPES, raw.type)) {
    const b: TextBlock = { id, type: raw.type, content: str(raw.content) };
    if (b.type === 'todo') b.checked = raw.checked === true;
    return b;
  }
  return null;
}

/** Returns a well-formed Note, filling defaults for fields older versions did not have, or null if unusable. */
export function normalizeNote(raw: unknown): Note | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id || raw.id === VAULT_RECORD_ID) return null;
  const deleted = raw.deleted === true;
  const blocks = Array.isArray(raw.blocks) ? raw.blocks.map(normalizeBlock).filter((b): b is Block => b !== null) : [];
  const stickyColor = raw.stickyColor;
  return {
    id: raw.id,
    parentId: typeof raw.parentId === 'string' && raw.parentId ? raw.parentId : null,
    title: str(raw.title),
    category: oneOf(CATEGORY_IDS, raw.category) ? raw.category : 'note',
    collapsed: raw.collapsed === true,
    isSticky: raw.isSticky === true,
    stickyColor: typeof stickyColor === 'string' && Object.hasOwn(STICKY_COLORS, stickyColor) ? (stickyColor as StickyColor) : 'yellow',
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    deleted,
    blocks: blocks.length || deleted ? blocks : [textBlock()],
    ...(typeof raw.order === 'number' && Number.isFinite(raw.order) ? { order: raw.order } : {}),
  };
}
