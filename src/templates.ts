import {
  field, fieldsBlock, now, textBlock, uid,
  type Block, type CategoryId, type FieldKind, type Note,
} from './model';

export interface Category { id: CategoryId; label: string; icon: string; titlePlaceholder: string }

export const CATEGORIES: Record<CategoryId, Category> = {
  note: { id: 'note', label: 'Note', icon: '📝', titlePlaceholder: 'Untitled note' },
  email: { id: 'email', label: 'Email account', icon: '✉️', titlePlaceholder: 'Account name, e.g. Personal Gmail' },
  login: { id: 'login', label: 'Website login', icon: '🔑', titlePlaceholder: 'Site name, e.g. GitHub' },
  proxy: { id: 'proxy', label: 'Proxy', icon: '🌐', titlePlaceholder: 'Proxy name, e.g. US residential #1' },
  secure: { id: 'secure', label: 'Secure note', icon: '🔒', titlePlaceholder: 'What is this? e.g. Home Wi-Fi' },
  meeting: { id: 'meeting', label: 'Meeting', icon: '📅', titlePlaceholder: 'Meeting title' },
};

export interface Template {
  id: string;
  name: string;
  description: string;
  category: CategoryId;
  build(): Block[];
}

type FieldSpec = [label: string, kind: FieldKind, hint?: string];
const group = (specs: FieldSpec[]) =>
  fieldsBlock(specs.map(([label, kind, hint]) => field(label, kind, hint ? { hint } : {})));

function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const TEMPLATES: Template[] = [
  {
    id: 'blank',
    name: 'Blank page',
    description: 'Start from an empty paragraph.',
    category: 'note',
    build: () => [textBlock()],
  },
  {
    id: 'email',
    name: 'Email account',
    description: 'Address, password, recovery details and backup codes.',
    category: 'email',
    build: () => [
      group([
        ['Email address', 'email', 'name@gmail.com'],
        ['Password', 'password'],
        ['2FA code', 'totp'],
        ['Recovery email', 'email'],
        ['Recovery phone', 'tel'],
        ['2-Step Verification', 'text', 'e.g. Passkey, authenticator app, SMS'],
        ['Backup codes', 'secret-text'],
      ]),
      textBlock('h2', 'Notes'),
      textBlock(),
    ],
  },
  {
    id: 'login',
    name: 'Website login',
    description: 'Site URL, username and password.',
    category: 'login',
    build: () => [
      group([
        ['Site URL', 'url', 'https://'],
        ['Username', 'text'],
        ['Password', 'password'],
        ['2FA code', 'totp'],
      ]),
      textBlock('h2', 'Notes'),
      textBlock(),
    ],
  },
  {
    id: 'proxy',
    name: 'Proxy',
    description: 'Connection link (ip:port:user:password), IP address, port, user, password and a note.',
    category: 'proxy',
    // The link contains the password, so it is a secret field (masked, not searchable) like the password.
    build: () => [
      group([
        ['Link', 'password', 'ip:port:user:password'],
        ['IP address', 'text', 'e.g. 203.0.113.10'],
        ['Port', 'text', 'e.g. 8080'],
        ['User', 'text'],
        ['Password', 'password'],
        ['Note', 'text', 'Provider, location, expiry…'],
      ]),
    ],
  },
  {
    id: 'secure',
    name: 'Secure note',
    description: 'One hidden text area for anything sensitive, such as Wi-Fi or license keys.',
    category: 'secure',
    build: () => [group([['Secret', 'secret-text']])],
  },
  {
    id: 'meeting',
    name: 'Meeting / general note',
    description: 'Date and attendees, plus Agenda and Action items sections.',
    category: 'meeting',
    build: () => {
      const fields = group([['Date', 'date'], ['Attendees', 'text', 'Who was there?']]);
      fields.fields[0]!.value = todayIso();
      return [fields, textBlock('h2', 'Agenda'), textBlock(), textBlock('h2', 'Action items'), textBlock('todo')];
    },
  },
];

/** The form (template) a category comes with, or null (plain notes have none). */
export function formForCategory(category: CategoryId): Template | null {
  return TEMPLATES.find(t => t.category === category && t.id !== 'blank') ?? null;
}

const fieldLabels = (blocks: Block[]) =>
  blocks.flatMap(b => (b.type === 'fields' ? b.fields.map(f => f.label.trim().toLowerCase()) : []));

/** True when the page already has every field of the form (so asking again would only duplicate it). */
export function hasForm(note: Note, template: Template): boolean {
  const have = new Set(fieldLabels(note.blocks));
  const want = fieldLabels(template.build());
  return want.length > 0 && want.every(l => have.has(l));
}

const KIND_ICONS: Record<FieldKind, string> = {
  text: '✏️', email: '✉️', url: '🔗', tel: '📞', date: '📅', password: '🔑', 'secret-text': '🔒', totp: '🔐',
};

/** What a form adds, for the confirmation dialog: fields first, then section headings. */
export function describeForm(template: Template): { icon: string; text: string }[] {
  const blocks = template.build();
  const fields = blocks.flatMap(b => (b.type === 'fields' ? b.fields.map(f => ({ icon: KIND_ICONS[f.kind], text: f.label })) : []));
  const sections = blocks.flatMap(b => (b.type === 'h1' || b.type === 'h2' ? [{ icon: '§', text: `${b.content} section` }] : []));
  return [...fields, ...sections];
}

/** Blank page = only empty paragraphs. */
const isBlankPage = (note: Note) => note.blocks.every(b => b.type === 'p' && !b.content.trim());

/**
 * Adds a category's form to a page: it replaces a blank page, or goes on top of existing content
 * (nothing is removed; trailing empty paragraphs of the form are dropped). Returns the first new block.
 */
export function applyForm(note: Note, template: Template): Block | null {
  const form = template.build();
  if (isBlankPage(note)) {
    note.blocks = form;
  } else {
    while (form.length > 1) {
      const last = form[form.length - 1]!;
      if (last.type === 'p' && !last.content) form.pop(); else break;
    }
    note.blocks = [...form, ...note.blocks];
  }
  return form[0] ?? null;
}

export function createNoteFromTemplate(template: Template, parentId: string | null): Note {
  return {
    id: uid(),
    parentId,
    title: '',
    category: template.category,
    collapsed: false,
    isSticky: false,
    stickyColor: 'yellow',
    updatedAt: now(),
    deleted: false,
    blocks: template.build(),
  };
}
