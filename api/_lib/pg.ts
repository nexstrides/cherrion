// Postgres repository (Vercel Postgres / Neon) over Neon's HTTP driver. Tables are created on first use.
import { neon } from '@neondatabase/serverless';
import type { Envelope } from '../../src/envelope.js';
import type { VaultHeader } from '../../src/vault.js';
import type { Account, Repo } from './core.js';
import type { Invite, Member, Role, SealedKeys, Workspace, WorkspaceMeta } from './workspaces.js';
import { SEEN_EVERY_MS, type EventKind, type EventRow, type RecoveryRequest, type RequestStatus } from './admin.js';

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
    // Admin dashboard: last seen, connection history (30 days), owner recovery (opt-in escrow),
    // recovery requests, reset codes, admin sessions and small settings.
    sql`alter table cherrion_accounts add column if not exists last_seen_at timestamptz`,
    sql`alter table cherrion_accounts add column if not exists last_ip text`,
    sql`alter table cherrion_accounts add column if not exists last_user_agent text`,
    sql`alter table cherrion_accounts add column if not exists last_country text`,
    sql`alter table cherrion_accounts add column if not exists last_region text`,
    sql`alter table cherrion_accounts add column if not exists last_city text`,
    sql`alter table cherrion_accounts add column if not exists escrow jsonb`,
    sql`create table if not exists cherrion_events (
      id bigserial primary key,
      at timestamptz not null default now(),
      kind text not null,
      account_id uuid references cherrion_accounts(id) on delete set null,
      username text,
      ip text, user_agent text, country text, region text, city text
    )`,
    sql`create index if not exists cherrion_events_at on cherrion_events (at)`,
    sql`create index if not exists cherrion_events_account on cherrion_events (account_id, at)`,
    sql`create index if not exists cherrion_events_ip on cherrion_events (ip, kind, at)`,
    sql`create table if not exists cherrion_recovery_requests (
      id uuid primary key,
      at timestamptz not null default now(),
      username text not null,
      account_id uuid references cherrion_accounts(id) on delete set null,
      contact text not null,
      message text not null,
      status text not null,
      ip text, user_agent text, country text, region text, city text
    )`,
    sql`create table if not exists cherrion_reset_codes (
      account_id uuid primary key references cherrion_accounts(id) on delete cascade,
      code_hash text not null,
      expires_at timestamptz not null
    )`,
    sql`create table if not exists cherrion_admin_sessions (token_hash text primary key, expires_at timestamptz not null)`,
    sql`create table if not exists cherrion_settings (key text primary key, value text not null)`,
  ]);
  const db = async () => { ready ??= migrate().catch(err => { ready = null; throw err; }); await ready; };

  const toAccount = (r: Row): Account => ({
    id: String(r.id), username: String(r.username), header: r.header as VaultHeader,
    authHash: String(r.auth_hash), recoveryAuthHash: String(r.recovery_auth_hash),
    publicKey: typeof r.public_key === 'string' ? r.public_key : null,
  });
  const toWorkspace = (r: Row): Workspace => ({
    id: String(r.id), meta: r.meta as WorkspaceMeta, epoch: Number(r.epoch), createdBy: String(r.created_by ?? ''),
  });
  const toMember = (r: Row): Member => ({
    workspaceId: String(r.workspace_id), accountId: String(r.account_id), role: r.role as Role, keys: r.keys as SealedKeys,
  });
  const toInvite = (r: Row): Invite => ({
    id: String(r.id), workspaceId: String(r.workspace_id), role: r.role as Role,
    inviteeId: r.invitee_id ? String(r.invitee_id) : null, payload: r.payload as Invite['payload'],
    authHash: r.auth_hash ? String(r.auth_hash) : null, createdBy: String(r.created_by ?? ''),
    expiresAt: new Date(String(r.expires_at)).getTime(),
  });

  const ms = (v: unknown): number => new Date(String(v)).getTime();
  const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
  const toEvent = (r: Row): EventRow => ({
    id: String(r.id), at: ms(r.at), kind: r.kind as EventKind,
    accountId: r.account_id ? String(r.account_id) : null, username: r.username ? String(r.username) : null,
    ip: str(r.ip), userAgent: str(r.user_agent), country: str(r.country), region: str(r.region), city: str(r.city),
  });
  const toRequest = (r: Row): RecoveryRequest => ({
    id: String(r.id), at: ms(r.at), username: String(r.username), accountId: r.account_id ? String(r.account_id) : null,
    contact: String(r.contact), message: String(r.message), status: r.status as RequestStatus,
    ip: str(r.ip), userAgent: str(r.user_agent), country: str(r.country), region: str(r.region), city: str(r.city),
  });
  const nullable = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

  return {
    persistent: true,
    // ---- Admin dashboard ----
    async logEvent(e) {
      await db();
      await sql`insert into cherrion_events (kind, account_id, username, ip, user_agent, country, region, city)
        values (${e.kind}, ${e.accountId}, ${e.username}, ${e.ip}, ${e.userAgent}, ${e.country}, ${e.region}, ${e.city})`;
    },
    async events({ accountId, since, limit }) {
      await db();
      const from = new Date(since).toISOString();
      const rows = accountId
        ? await sql`select * from cherrion_events where account_id = ${accountId} and at >= ${from} order by at desc, id desc limit ${limit}`
        : await sql`select * from cherrion_events where at >= ${from} order by at desc, id desc limit ${limit}`;
      return rows.map(toEvent);
    },
    async countEvents({ kinds, ip, since }) {
      await db();
      const from = new Date(since).toISOString();
      const rows = ip
        ? await sql`select count(*)::int as n from cherrion_events where kind = any(${kinds}) and ip = ${ip} and at >= ${from}`
        : await sql`select count(*)::int as n from cherrion_events where kind = any(${kinds}) and at >= ${from}`;
      return Number(rows[0]?.n ?? 0);
    },
    async pruneEvents(before) {
      await db();
      await sql`delete from cherrion_events where at < ${new Date(before).toISOString()}`;
    },
    async touchAccount(accountId, c, at) {
      await db();
      const now = new Date(at).toISOString();
      const stale = new Date(at - SEEN_EVERY_MS).toISOString();
      await sql`update cherrion_accounts set last_seen_at = ${now}, last_ip = ${c.ip}, last_user_agent = ${c.userAgent},
        last_country = ${c.country}, last_region = ${c.region}, last_city = ${c.city}
        where id = ${accountId} and (last_seen_at is null or last_seen_at < ${stale} or last_ip is distinct from ${c.ip})`;
    },
    async users() {
      await db();
      const rows = await sql`select a.id, a.username, a.created_at, a.last_seen_at, a.last_ip, a.last_user_agent,
          a.last_country, a.last_region, a.last_city, a.escrow->>'adminKey' as escrow_key,
          (select count(*)::int from cherrion_notes n where n.account_id = a.id and not n.deleted) as notes,
          (select count(*)::int from cherrion_workspace_members m where m.account_id = a.id) as workspaces
        from cherrion_accounts a order by a.created_at desc`;
      return rows.map(r => ({
        id: String(r.id), username: String(r.username), createdAt: ms(r.created_at),
        notes: Number(r.notes ?? 0), workspaces: Number(r.workspaces ?? 0),
        lastSeenAt: r.last_seen_at ? ms(r.last_seen_at) : null, lastIp: nullable(r.last_ip), lastUserAgent: nullable(r.last_user_agent),
        lastCountry: nullable(r.last_country), lastRegion: nullable(r.last_region), lastCity: nullable(r.last_city),
        escrowKey: nullable(r.escrow_key),
      }));
    },
    async getEscrow(accountId) {
      await db();
      const rows = await sql`select escrow from cherrion_accounts where id = ${accountId}`;
      const e = rows[0]?.escrow as { adminKey?: unknown; sealed?: unknown; at?: unknown } | null | undefined;
      return e && typeof e.adminKey === 'string' && typeof e.sealed === 'string' ? { adminKey: e.adminKey, sealed: e.sealed, at: Number(e.at ?? 0) } : null;
    },
    async setEscrow(accountId, escrow) {
      await db();
      await sql`update cherrion_accounts set escrow = ${escrow ? JSON.stringify(escrow) : null}::jsonb where id = ${accountId}`;
    },
    async createRequest(r) {
      await db();
      await sql`insert into cherrion_recovery_requests (id, at, username, account_id, contact, message, status, ip, user_agent, country, region, city)
        values (${r.id}, ${new Date(r.at).toISOString()}, ${r.username}, ${r.accountId}, ${r.contact}, ${r.message}, ${r.status},
          ${r.ip}, ${r.userAgent}, ${r.country}, ${r.region}, ${r.city})`;
    },
    async requests(limit) {
      await db();
      const rows = await sql`select * from cherrion_recovery_requests order by at desc limit ${limit}`;
      return rows.map(toRequest);
    },
    async setRequestStatus(id, status) {
      await db();
      await sql`update cherrion_recovery_requests set status = ${status} where id = ${id}`;
    },
    async putResetCode(accountId, codeHash, expiresAt) {
      await db();
      await sql`insert into cherrion_reset_codes (account_id, code_hash, expires_at)
        values (${accountId}, ${codeHash}, ${new Date(expiresAt).toISOString()})
        on conflict (account_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at`;
    },
    async takeResetCode(accountId, codeHash, now) {
      await db();
      const rows = await sql`delete from cherrion_reset_codes
        where account_id = ${accountId} and code_hash = ${codeHash} and expires_at > ${new Date(now).toISOString()} returning account_id`;
      return rows.length > 0;
    },
    async createAdminSession(tokenHash, expiresAt) {
      await db();
      await sql.transaction([
        sql`delete from cherrion_admin_sessions where expires_at < now()`,
        sql`insert into cherrion_admin_sessions (token_hash, expires_at) values (${tokenHash}, ${new Date(expiresAt).toISOString()})`,
      ]);
    },
    async findAdminSession(tokenHash, now) {
      await db();
      const rows = await sql`select 1 from cherrion_admin_sessions where token_hash = ${tokenHash} and expires_at > ${new Date(now).toISOString()}`;
      return rows.length > 0;
    },
    async deleteAdminSession(tokenHash) {
      await db();
      await sql`delete from cherrion_admin_sessions where token_hash = ${tokenHash}`;
    },
    async getSetting(key) {
      await db();
      const rows = await sql`select value from cherrion_settings where key = ${key}`;
      return rows[0] ? String(rows[0].value) : null;
    },
    async setSetting(key, value) {
      await db();
      await sql`insert into cherrion_settings (key, value) values (${key}, ${value}) on conflict (key) do update set value = excluded.value`;
    },
    async resetAccount(accountId, f) {
      await db();
      await sql.transaction([
        sql`delete from cherrion_notes where account_id = ${accountId}`,
        sql`delete from cherrion_sessions where account_id = ${accountId}`,
        sql`delete from cherrion_reset_codes where account_id = ${accountId}`,
        sql`update cherrion_accounts set header = ${JSON.stringify(f.header)}::jsonb, auth_hash = ${f.authHash},
          recovery_auth_hash = ${f.recoveryAuthHash}, public_key = null, escrow = null where id = ${accountId}`,
      ]);
    },
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
        sql`insert into cherrion_workspaces (id, meta, epoch, created_by) values (${ws.id}, ${JSON.stringify(ws.meta)}::jsonb, ${ws.epoch}, ${ws.createdBy})`,
        sql`insert into cherrion_workspace_members (workspace_id, account_id, role, keys)
          values (${owner.workspaceId}, ${owner.accountId}, ${owner.role}, ${JSON.stringify(owner.keys)}::jsonb)`,
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
        epoch = coalesce(${f.epoch ?? null}::integer, epoch)
        where id = ${id}`;
    },
    async deleteWorkspace(id) {
      await db();
      await sql`delete from cherrion_workspaces where id = ${id}`;
    },
    async workspacesOf(accountId) {
      await db();
      const rows = await sql`select w.*, m.workspace_id, m.account_id, m.role, m.keys
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
      await sql`insert into cherrion_workspace_members (workspace_id, account_id, role, keys)
        values (${m.workspaceId}, ${m.accountId}, ${m.role}, ${JSON.stringify(m.keys)}::jsonb)
        on conflict (workspace_id, account_id) do update set role = excluded.role, keys = excluded.keys`;
    },
    async removeMember(workspaceId, accountId) {
      await db();
      await sql`delete from cherrion_workspace_members where workspace_id = ${workspaceId} and account_id = ${accountId}`;
    },
    async createInvite(i) {
      await db();
      await sql`insert into cherrion_workspace_invites (id, workspace_id, role, invitee_id, payload, auth_hash, created_by, expires_at)
        values (${i.id}, ${i.workspaceId}, ${i.role}, ${i.inviteeId}, ${JSON.stringify(i.payload)}::jsonb, ${i.authHash},
          ${i.createdBy}, ${new Date(i.expiresAt).toISOString()})`;
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
  };
}
