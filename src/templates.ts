import {
  field, fieldsBlock, now, textBlock, uid,
  type Block, type CategoryId, type FieldKind, type Note,
} from './model';

export interface Category { id: CategoryId; label: string; icon: string; titlePlaceholder: string }

export const CATEGORIES: Record<CategoryId, Category> = {
  note: { id: 'note', label: 'Note', icon: '📝', titlePlaceholder: 'Untitled note' },
  email: { id: 'email', label: 'Email account', icon: '✉️', titlePlaceholder: 'Account name, e.g. Personal Gmail' },
  login: { id: 'login', label: 'Website login', icon: '🔑', titlePlaceholder: 'Site name, e.g. GitHub' },
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
