// Postgres repository (Vercel Postgres / Neon) over Neon's HTTP driver. Tables are created on first use.
import { neon } from '@neondatabase/serverless';
import type { Envelope } from '../../src/envelope.js';
import type { VaultHeader } from '../../src/vault.js';
import type { Account, Repo } from './core.js';
import type { Invite, Member, Role, SealedKeys, Workspace, WorkspaceMeta } from './workspaces.js';

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
    // Shared workspaces
    sql`alter table cherrion_accounts add column if not exists public_key text`,
    sql`create table if not exists cherrion_workspaces (
      id uuid primary key,
      meta jsonb not null,
      epoch integer not null,
      created_by uuid references cherrion_accounts(id) on delete set null,
      created_at timestamptz not null default now()
    )`,
    sql`create table if not exists cherrion_workspace_members (
      workspace_id uuid not null references cherrion_workspaces(id) on delete cascade,
      account_id uuid not null references cherrion_accounts(id) on delete cascade,
      role text not null,
      keys jsonb not null,
      primary key (workspace_id, account_id)
    )`,
    sql`create index if not exists cherrion_workspace_members_account on cherrion_workspace_members (account_id)`,
    sql`create table if not exists cherrion_workspace_invites (
      id uuid primary key,
      workspace_id uuid not null references cherrion_workspaces(id) on delete cascade,
      role text not null,
      invitee_id uuid references cherrion_accounts(id) on delete cascade,
      payload jsonb not null,
      auth_hash text,
      created_by uuid references cherrion_accounts(id) on delete cascade,
      expires_at timestamptz not null
    )`,
    sql`create table if not exists cherrion_workspace_notes (
      workspace_id uuid not null references cherrion_workspaces(id) on delete cascade,
      id text not null,
      updated_at bigint not null,
      deleted boolean not null,
      envelope jsonb not null,
      rev bigint not null,
      author_id uuid,
      primary key (workspace_id, id)
    )`,
    sql`create index if not exists cherrion_workspace_notes_rev on cherrion_workspace_notes (workspace_id, rev)`,
    // Secret fields hidden from viewers (secrets keys for owners and editors)
    sql`alter table cherrion_workspaces add column if not exists viewer_secrets boolean not null default true`,
    sql`alter table cherrion_workspace_members add column if not exists skeys jsonb not null default '{}'::jsonb`,
    sql`alter table cherrion_workspace_invites add column if not exists skeys jsonb`,
    // File attachments: encrypted chunks (see files.ts)
    sql`create table if not exists cherrion_files (
      id uuid not null,
      idx integer not null,
      count integer not null,
      owner_id uuid not null references cherrion_accounts(id) on delete cascade,
      nonce text not null,
      ct text not null,
      created_at timestamptz not null default now(),
      primary key (id, idx)
    )`,
    sql`create index if not exists cherrion_files_owner on cherrion_files (owner_id)`,
  ]);
  const db = async () => { ready ??= migrate().catch(err => { ready = null; throw err; }); await ready; };

  const toAccount = (r: Row): Account => ({
    id: String(r.id), username: String(r.username), header: r.header as VaultHeader,
    authHash: String(r.auth_hash), recoveryAuthHash: String(r.recovery_auth_hash),
    publicKey: typeof r.public_key === 'string' ? r.public_key : null,
  });
  const toWorkspace = (r: Row): Workspace => ({
    id: String(r.id), meta: r.meta as WorkspaceMeta, epoch: Number(r.epoch), createdBy: String(r.created_by ?? ''),
    viewerSecrets: r.viewer_secrets !== false,
  });
  const toMember = (r: Row): Member => ({
    workspaceId: String(r.workspace_id), accountId: String(r.account_id), role: r.role as Role, keys: r.keys as SealedKeys,
    skeys: (r.skeys ?? {}) as SealedKeys,
  });
  const toInvite = (r: Row): Invite => ({
    id: String(r.id), workspaceId: String(r.workspace_id), role: r.role as Role,
    inviteeId: r.invitee_id ? String(r.invitee_id) : null, payload: r.payload as Invite['payload'],
    authHash: r.auth_hash ? String(r.auth_hash) : null, createdBy: String(r.created_by ?? ''),
    expiresAt: new Date(String(r.expires_at)).getTime(), skeys: (r.skeys ?? null) as SealedKeys | null,
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
    // ---- Shared workspaces ----
    async setPublicKey(accountId, publicKey) {
      await db();
      const rows = await sql`update cherrion_accounts set public_key = coalesce(public_key, ${publicKey})
        where id = ${accountId} returning public_key`;
      return String(rows[0]?.public_key ?? publicKey);
    },
    async createWorkspace(ws, owner) {
      await db();
      await sql.transaction([
        sql`insert into cherrion_workspaces (id, meta, epoch, created_by, viewer_secrets)
          values (${ws.id}, ${JSON.stringify(ws.meta)}::jsonb, ${ws.epoch}, ${ws.createdBy}, ${ws.viewerSecrets})`,
        sql`insert into cherrion_workspace_members (workspace_id, account_id, role, keys, skeys)
          values (${owner.workspaceId}, ${owner.accountId}, ${owner.role}, ${JSON.stringify(owner.keys)}::jsonb, ${JSON.stringify(owner.skeys)}::jsonb)`,
      ]);
    },
    async getWorkspace(id) {
      await db();
      const rows = await sql`select * from cherrion_workspaces where id = ${id}`;
      return rows[0] ? toWorkspace(rows[0]) : null;
    },
    async updateWorkspace(id, f) {
      await db();
      await sql`update cherrion_workspaces set
        meta = coalesce(${f.meta ? JSON.stringify(f.meta) : null}::jsonb, meta),
        epoch = coalesce(${f.epoch ?? null}::integer, epoch),
        viewer_secrets = coalesce(${f.viewerSecrets ?? null}::boolean, viewer_secrets)
        where id = ${id}`;
    },
    async deleteWorkspace(id) {
      await db();
      await sql`delete from cherrion_workspaces where id = ${id}`;
    },
    async workspacesOf(accountId) {
      await db();
      const rows = await sql`select w.*, m.workspace_id, m.account_id, m.role, m.keys, m.skeys
        from cherrion_workspace_members m join cherrion_workspaces w on w.id = m.workspace_id
        where m.account_id = ${accountId} order by w.created_at`;
      return rows.map(r => ({ workspace: toWorkspace(r), member: toMember(r) }));
    },
    async members(workspaceId) {
      await db();
      const rows = await sql`select m.*, a.username, a.public_key from cherrion_workspace_members m
        join cherrion_accounts a on a.id = m.account_id where m.workspace_id = ${workspaceId} order by a.username`;
      return rows.map(r => ({ ...toMember(r), username: String(r.username), publicKey: typeof r.public_key === 'string' ? r.public_key : null }));
    },
    async getMember(workspaceId, accountId) {
      await db();
      const rows = await sql`select * from cherrion_workspace_members where workspace_id = ${workspaceId} and account_id = ${accountId}`;
      return rows[0] ? toMember(rows[0]) : null;
    },
    async putMember(m) {
      await db();
      await sql`insert into cherrion_workspace_members (workspace_id, account_id, role, keys, skeys)
        values (${m.workspaceId}, ${m.accountId}, ${m.role}, ${JSON.stringify(m.keys)}::jsonb, ${JSON.stringify(m.skeys ?? {})}::jsonb)
        on conflict (workspace_id, account_id) do update set role = excluded.role, keys = excluded.keys, skeys = excluded.skeys`;
    },
    async removeMember(workspaceId, accountId) {
      await db();
      await sql`delete from cherrion_workspace_members where workspace_id = ${workspaceId} and account_id = ${accountId}`;
    },
    async createInvite(i) {
      await db();
      await sql`insert into cherrion_workspace_invites (id, workspace_id, role, invitee_id, payload, auth_hash, created_by, expires_at, skeys)
        values (${i.id}, ${i.workspaceId}, ${i.role}, ${i.inviteeId}, ${JSON.stringify(i.payload)}::jsonb, ${i.authHash},
          ${i.createdBy}, ${new Date(i.expiresAt).toISOString()}, ${i.skeys ? JSON.stringify(i.skeys) : null}::jsonb)`;
    },
    async getInvite(id) {
      await db();
      const rows = await sql`select * from cherrion_workspace_invites where id = ${id}`;
      return rows[0] ? toInvite(rows[0]) : null;
    },
    async deleteInvite(id) {
      await db();
      await sql`delete from cherrion_workspace_invites where id = ${id}`;
    },
    async invitesFor(accountId) {
      await db();
      const rows = await sql`select * from cherrion_workspace_invites where invitee_id = ${accountId} and expires_at > now()`;
      return rows.map(toInvite);
    },
    async invitesOf(workspaceId) {
      await db();
      const rows = await sql`select * from cherrion_workspace_invites where workspace_id = ${workspaceId} and expires_at > now()`;
      return rows.map(toInvite);
    },
    async putWorkspaceNotes(workspaceId, notes: Envelope[], authorId) {
      await db();
      for (let i = 0; i < notes.length; i += 200) {
        await sql.transaction(notes.slice(i, i + 200).map(e => sql`
          insert into cherrion_workspace_notes (workspace_id, id, updated_at, deleted, envelope, rev, author_id)
          values (${workspaceId}, ${e.id}, ${e.updatedAt}, ${e.deleted}, ${JSON.stringify(e)}::jsonb, nextval('cherrion_note_rev'), ${authorId})
          on conflict (workspace_id, id) do update
            set updated_at = excluded.updated_at, deleted = excluded.deleted, envelope = excluded.envelope,
                rev = excluded.rev, author_id = excluded.author_id
            where cherrion_workspace_notes.updated_at < excluded.updated_at`));
      }
    },
    async workspaceNotesSince(workspaceId, since, limit) {
      await db();
      const rows = await sql`select envelope, rev from cherrion_workspace_notes
        where workspace_id = ${workspaceId} and rev > ${since} order by rev limit ${limit}`;
      return { notes: rows.map(r => r.envelope as Envelope), revs: rows.map(r => Number(r.rev)) };
    },
    async notesSince(accountId, since, limit) {
      await db();
      const rows = await sql`select envelope, rev from cherrion_notes
        where account_id = ${accountId} and rev > ${since} order by rev limit ${limit}`;
      return { notes: rows.map(r => r.envelope as Envelope), revs: rows.map(r => Number(r.rev)) };
    },
    async putFileChunk(c) {
      await db();
      await sql`insert into cherrion_files (id, idx, count, owner_id, nonce, ct)
        values (${c.fileId}, ${c.index}, ${c.count}, ${c.ownerId}, ${c.nonce}, ${c.ct})
        on conflict (id, idx) do update set count = excluded.count, nonce = excluded.nonce, ct = excluded.ct
        where cherrion_files.owner_id = excluded.owner_id`;
    },
    async getFileChunk(fileId, index) {
      await db();
      const rows = await sql`select * from cherrion_files where id = ${fileId} and idx = ${index}`;
      const r = rows[0];
      return r ? { fileId, index, count: Number(r.count), ownerId: String(r.owner_id), nonce: String(r.nonce), ct: String(r.ct) } : null;
    },
    async fileOwner(fileId) {
      await db();
      const rows = await sql`select owner_id from cherrion_files where id = ${fileId} limit 1`;
      return rows[0] ? String(rows[0].owner_id) : null;
    },
    async fileCharsOf(ownerId) {
      await db();
      const rows = await sql`select coalesce(sum(length(ct)), 0) as chars from cherrion_files where owner_id = ${ownerId}`;
      return Number(rows[0]?.chars ?? 0);
    },
    async deleteFile(fileId) {
      await db();
      await sql`delete from cherrion_files where id = ${fileId}`;
    },
  };
}
