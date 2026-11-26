// Proxy links: "ip:port:user:password" <-> the IP address / Port / User / Password fields.
import type { Field, FieldsBlock } from './model';

export interface ProxyParts { host: string; port: string; user: string; password: string }

const PORT = /^\d{1,5}$/;
const validPort = (p: string) => PORT.test(p) && Number(p) >= 1 && Number(p) <= 65535;

/**
 * Splits a proxy link on ":". Also accepts "user:password@host:port" and a scheme such as
 * "socks5://" or "http://". The password may itself contain ":". Returns null if it is not a link.
 */
export function parseProxyLink(text: string): ProxyParts | null {
  const t = text.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const at = t.lastIndexOf('@');
  if (at > 0) {
    const [user = '', ...pw] = t.slice(0, at).split(':');
    const m = /^(.+):(\d{1,5})$/.exec(t.slice(at + 1));
    return m && user && validPort(m[2]!) ? { host: m[1]!, port: m[2]!, user, password: pw.join(':') } : null;
  }
  const [host = '', port = '', user = '', ...pw] = t.split(':');
  if (pw.length === 0 || !host || !user || !validPort(port)) return null;
  return { host, port, user, password: pw.join(':') };
}

export const formatProxyLink = (p: ProxyParts): string =>
  (p.host || p.port || p.user || p.password ? [p.host, p.port, p.user, p.password].join(':') : '');

type Part = keyof ProxyParts;
const LABELS: Record<Part | 'link', string[]> = {
  link: ['link', 'proxy link', 'proxy'],
  host: ['ip address', 'ip', 'host', 'server'],
  port: ['port'],
  user: ['user', 'username', 'login'],
  password: ['password', 'pass'],
};
const PARTS: Part[] = ['host', 'port', 'user', 'password'];

/** The proxy fields of a field group, matched by label (null unless it has a Link and IP/port fields). */
export function proxyFields(block: FieldsBlock): ({ link: Field } & Partial<Record<Part, Field>>) | null {
  const find = (names: string[]) => block.fields.find(f => names.includes(f.label.trim().toLowerCase()));
  const link = find(LABELS.link);
  const host = find(LABELS.host);
  const port = find(LABELS.port);
  if (!link || (!host && !port)) return null;
  return { link, host, port, user: find(LABELS.user), password: find(LABELS.password) };
}

/**
 * Keeps the link and the parts in step after `edited` changed (its old value was `before`):
 * - a full link fills IP address, port, user and password;
 * - editing a part rebuilds the link, unless the link was typed by hand (it no longer matches the parts).
 * Returns the fields whose values were changed here (so the page can show them).
 */
export function syncProxyFields(block: FieldsBlock, edited: Field, before: string): Field[] {
  const p = proxyFields(block);
  if (!p) return [];
  const changed: Field[] = [];
  if (edited === p.link) {
    const parts = parseProxyLink(edited.value);
    if (!parts) return [];
    for (const k of PARTS) {
      const f = p[k];
      if (f && f.value !== parts[k]) { f.value = parts[k]; changed.push(f); }
    }
    return changed;
  }
  const part = PARTS.find(k => p[k] === edited);
  if (!part) return [];
  const current = Object.fromEntries(PARTS.map(k => [k, p[k]?.value ?? ''])) as unknown as ProxyParts;
  const previous = { ...current, [part]: before };
  if (p.link.value !== '' && p.link.value !== formatProxyLink(previous)) return [];
  const next = formatProxyLink(current);
  if (next !== p.link.value) { p.link.value = next; changed.push(p.link); }
  return changed;
}
