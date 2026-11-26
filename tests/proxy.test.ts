import { describe, expect, it } from 'vitest';
import { fieldsBlock, field } from '../src/model';
import { formatProxyLink, parseProxyLink, proxyFields, syncProxyFields } from '../src/proxy';
import { formForCategory } from '../src/templates';

const proxyForm = () => {
  const block = formForCategory('proxy')!.build()[0]!;
  if (block.type !== 'fields') throw new Error('expected a field group');
  const by = (label: string) => block.fields.find(f => f.label === label)!;
  return { block, link: by('Link'), ip: by('IP address'), port: by('Port'), user: by('User'), password: by('Password'), note: by('Note') };
};

describe('proxy links', () => {
  it('splits ip:port:user:password, keeping ":" inside the password', () => {
    expect(parseProxyLink(' 203.0.113.10:8080:alice:s3cret ')).toEqual({ host: '203.0.113.10', port: '8080', user: 'alice', password: 's3cret' });
    expect(parseProxyLink('proxy.example.com:1080:bob:pa:ss')).toEqual({ host: 'proxy.example.com', port: '1080', user: 'bob', password: 'pa:ss' });
    expect(parseProxyLink('socks5://carol:pw@10.0.0.1:1080')).toEqual({ host: '10.0.0.1', port: '1080', user: 'carol', password: 'pw' });
  });

  it('rejects text that is not a proxy link', () => {
    for (const bad of ['', '1.2.3.4', '1.2.3.4:8080', '1.2.3.4:8080:user', '1.2.3.4:http:user:pw', '1.2.3.4:70000:u:p', ':80:u:p']) {
      expect(parseProxyLink(bad), bad).toBeNull();
    }
  });

  it('formats the parts back into a link', () => {
    expect(formatProxyLink({ host: '1.2.3.4', port: '80', user: 'u', password: 'p' })).toBe('1.2.3.4:80:u:p');
    expect(formatProxyLink({ host: '', port: '', user: '', password: '' })).toBe('');
  });
});

describe('proxy form', () => {
  it('fills IP address, port, user and password when a link is pasted', () => {
    const f = proxyForm();
    f.link.value = '203.0.113.10:8080:alice:s3cret';
    const changed = syncProxyFields(f.block, f.link, '');
    expect([f.ip.value, f.port.value, f.user.value, f.password.value]).toEqual(['203.0.113.10', '8080', 'alice', 's3cret']);
    expect(changed).toEqual([f.ip, f.port, f.user, f.password]);
    expect(f.note.value).toBe('');
  });

  it('builds the link from the parts, and keeps it in step', () => {
    const f = proxyForm();
    for (const [field_, value] of [[f.ip, '1.2.3.4'], [f.port, '80'], [f.user, 'u'], [f.password, 'p']] as const) {
      const before = field_.value;
      field_.value = value;
      syncProxyFields(f.block, field_, before);
    }
    expect(f.link.value).toBe('1.2.3.4:80:u:p');
    f.port.value = '8080';
    syncProxyFields(f.block, f.port, '80');
    expect(f.link.value).toBe('1.2.3.4:8080:u:p');
  });

  it('leaves a hand-typed link alone', () => {
    const f = proxyForm();
    f.link.value = 'my own notes about this proxy';
    f.ip.value = '1.2.3.4';
    expect(syncProxyFields(f.block, f.ip, '')).toEqual([]);
    expect(f.link.value).toBe('my own notes about this proxy');
  });

  it('only acts on groups that have a Link and IP/port fields', () => {
    expect(proxyFields(fieldsBlock([field('Link'), field('Site URL', 'url')]))).toBeNull();
    expect(proxyFields(proxyForm().block)?.link.label).toBe('Link');
  });
});
