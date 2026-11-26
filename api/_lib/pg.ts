// Postgres repository (Vercel Postgres / Neon) over Neon's HTTP driver. Tables are created on first use.
import { neon } from '@neondatabase/serverless';
import type { Envelope } from '../../src/envelope.js';
import type { VaultHeader } from '../../src/vault.js';
import type { Account, Repo } from './core.js';

type Row = Record<string, unknown>;

export function createPgRepo(connectionString: string): Repo {
  const sql = neon(connectionString);
  let ready: Promise<unknown> | null = null;

  const migrate = () => sql.transaction([
    sql`create table if not exists cherrion_accounts (
      id uuid primary key default gen_random_uuid(),
      username text not null unique,
      header jsonb not null,
      auth_hash text not null,
      recovery_auth_hash text not null,
      created_at timestamptz not null default now()
    )`,
    sql`create table if not exists cherrion_sessions (
      token_hash text primary key,
      account_id uuid not null references cherrion_accounts(id) on delete cascade,
      expires_at timestamptz not null
    )`,
    sql`create sequence if not exists cherrion_note_rev`,
    sql`create table if not exists cherrion_notes (
      account_id uuid not null references cherrion_accounts(id) on delete cascade,
      id text not null,
      updated_at bigint not null,
      deleted boolean not null,
      envelope jsonb not null,
      rev bigint not null,
      primary key (account_id, id)
    )`,
    sql`create index if not exists cherrion_notes_rev on cherrion_notes (account_id, rev)`,
  ]);
  const db = async () => { ready ??= migrate().catch(err => { ready = null; throw err; }); await ready; };

  const toAccount = (r: Row): Account => ({
    id: String(r.id), username: String(r.username), header: r.header as VaultHeader,
    authHash: String(r.auth_hash), recoveryAuthHash: String(r.recovery_auth_hash),
  });

  return {
    persistent: true,
    async findAccount(username) {
      await db();
      const rows = await sql`select * from cherrion_accounts where username = ${username}`;
      return rows[0] ? toAccount(rows[0]) : null;
    },
    async findAccountById(id) {
      await db();
      const rows = await sql`select * from cherrion_accounts where id = ${id}`;
      return rows[0] ? toAccount(rows[0]) : null;
    },
    async createAccount(username, header, authHash, recoveryAuthHash) {
      await db();
      const rows = await sql`insert into cherrion_accounts (username, header, auth_hash, recovery_auth_hash)
        values (${username}, ${JSON.stringify(header)}::jsonb, ${authHash}, ${recoveryAuthHash})
        on conflict (username) do nothing returning *`;
      return rows[0] ? toAccount(rows[0]) : null;
    },
    async updateAccount(id, f) {
      await db();
      await sql`update cherrion_accounts set
        header = coalesce(${f.header ? JSON.stringify(f.header) : null}::jsonb, header),
        auth_hash = coalesce(${f.authHash ?? null}, auth_hash),
        recovery_auth_hash = coalesce(${f.recoveryAuthHash ?? null}, recovery_auth_hash)
        where id = ${id}`;
    },
    async createSession(tokenHash, accountId, expiresAt) {
      await db();
      await sql.transaction([
        sql`delete from cherrion_sessions where expires_at < now()`,
        sql`insert into cherrion_sessions (token_hash, account_id, expires_at) values (${tokenHash}, ${accountId}, ${expiresAt.toISOString()})`,
      ]);
    },
    async findSession(tokenHash) {
      await db();
      const rows = await sql`select account_id from cherrion_sessions where token_hash = ${tokenHash} and expires_at > now()`;
      return rows[0] ? String(rows[0].account_id) : null;
    },
    async deleteSession(tokenHash) {
      await db();
      await sql`delete from cherrion_sessions where token_hash = ${tokenHash}`;
    },
    async putNotes(accountId, notes: Envelope[]) {
      await db();
      for (let i = 0; i < notes.length; i += 200) {
        await sql.transaction(notes.slice(i, i + 200).map(e => sql`
          insert into cherrion_notes (account_id, id, updated_at, deleted, envelope, rev)
          values (${accountId}, ${e.id}, ${e.updatedAt}, ${e.deleted}, ${JSON.stringify(e)}::jsonb, nextval('cherrion_note_rev'))
          on conflict (account_id, id) do update
            set updated_at = excluded.updated_at, deleted = excluded.deleted, envelope = excluded.envelope, rev = excluded.rev
            where cherrion_notes.updated_at < excluded.updated_at`));
      }
    },
    async notesSince(accountId, since, limit) {
      await db();
      const rows = await sql`select envelope, rev from cherrion_notes
        where account_id = ${accountId} and rev > ${since} order by rev limit ${limit}`;
      return { notes: rows.map(r => r.envelope as Envelope), revs: rows.map(r => Number(r.rev)) };
    },
  };
}
