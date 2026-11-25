import { beforeAll, describe, expect, it } from 'vitest';
import { DecryptError, initCrypto, randomKey } from '../src/crypto';
import { decryptNote, encryptNote, isEnvelope } from '../src/envelope';
import { createNoteFromTemplate, TEMPLATES } from '../src/templates';

beforeAll(() => initCrypto());

const emailTemplate = TEMPLATES.find(t => t.id === 'email')!;

describe('note envelopes', () => {
  it('round-trips a note and exposes only id, updatedAt and deleted', () => {
    const key = randomKey();
    const note = createNoteFromTemplate(emailTemplate, null);
    note.title = 'Personal Gmail';
    const env = encryptNote(key, note);
    expect(Object.keys(env).sort()).toEqual(['ct', 'deleted', 'id', 'nonce', 'updatedAt', 'v']);
    expect(JSON.stringify(env)).not.toContain('Gmail');
    expect(decryptNote(key, env)).toEqual(note);
    expect(isEnvelope(JSON.parse(JSON.stringify(env)))).toBe(true);
  });

  it('rejects ciphertext moved to another note id', () => {
    const key = randomKey();
    const env = encryptNote(key, createNoteFromTemplate(emailTemplate, null));
    expect(() => decryptNote(key, { ...env, id: 'someone-else' })).toThrow(DecryptError);
  });

  it('rejects a flipped deleted flag or changed timestamp', () => {
    const key = randomKey();
    const env = encryptNote(key, createNoteFromTemplate(emailTemplate, null));
    expect(() => decryptNote(key, { ...env, deleted: true })).toThrow(DecryptError);
    expect(() => decryptNote(key, { ...env, updatedAt: env.updatedAt + 1 })).toThrow(DecryptError);
  });

  it('rejects the wrong key', () => {
    const env = encryptNote(randomKey(), createNoteFromTemplate(emailTemplate, null));
    expect(() => decryptNote(randomKey(), env)).toThrow(DecryptError);
  });

  it('does not treat plaintext notes or the vault record as envelopes', () => {
    expect(isEnvelope({ id: 'a', updatedAt: 1, deleted: false, title: 'x', blocks: [] })).toBe(false);
    expect(isEnvelope({ id: '__vault__', updatedAt: 1, deleted: false, v: 1, nonce: 'n', ct: 'c' })).toBe(false);
  });
});
