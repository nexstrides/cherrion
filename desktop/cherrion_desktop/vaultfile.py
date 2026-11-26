"""One Cherrion vault = one SQLite file (like a CherryTree .ctb), holding only ciphertext.

The file stores the same data the web version keeps on the server: the key-wrapped vault header and
one encrypted envelope per note. Decryption happens in the app window; this module never sees a key.

    meta  (key, value)                       header JSON, sync settings
    notes (id, updated_at, deleted, envelope, dirty)
                                              dirty = changed here, not yet on the sync server

The connection uses SQLite's exclusive locking mode, so a second Cherrion window cannot open the
same file and overwrite it, and the rollback journal, so the file stays a single file at rest.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterable

APPLICATION_ID = 0x43485259  # "CHRY": marks the file as a Cherrion vault
SCHEMA_VERSION = 1
EXTENSION = '.cherrion'

_SCHEMA = """
create table meta (
  key   text primary key,
  value text not null
);
create table notes (
  id         text primary key,
  updated_at integer not null,
  deleted    integer not null,
  envelope   text not null,
  dirty      integer not null default 0
);
"""

# Meta keys the app may write (anything else is refused).
META_KEYS = {'sync_url', 'sync_username', 'sync_since'}


class VaultFileError(Exception):
    """A problem worth showing to the user as is."""


def _check_envelope(env: Any) -> dict:
    if not isinstance(env, dict):
        raise VaultFileError('Invalid note data.')
    if not isinstance(env.get('id'), str) or not env['id'] or len(env['id']) > 200:
        raise VaultFileError('Invalid note id.')
    if not isinstance(env.get('updatedAt'), int) or isinstance(env.get('updatedAt'), bool):
        raise VaultFileError('Invalid note timestamp.')
    if not isinstance(env.get('deleted'), bool):
        raise VaultFileError('Invalid note flag.')
    if not isinstance(env.get('ct'), str) or not isinstance(env.get('nonce'), str):
        raise VaultFileError('Notes must be encrypted.')
    return env


def _check_header(header: Any) -> dict:
    if not isinstance(header, dict) or not isinstance(header.get('vaultId'), str) or 'kdf' not in header:
        raise VaultFileError('Invalid vault header.')
    return header


def _dumps(value: Any) -> str:
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False)


def _connect(path: Path, create: bool) -> sqlite3.Connection:
    uri = f"{path.resolve().as_uri()}?mode={'rwc' if create else 'rw'}"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=0.5, isolation_level=None, check_same_thread=False)
    except sqlite3.OperationalError as err:
        raise VaultFileError(f'Cannot open {path.name}: {err}.') from err
    try:
        conn.execute('pragma locking_mode = exclusive')
        conn.execute('pragma journal_mode = delete')
        conn.execute('pragma synchronous = full')
        # Take the exclusive lock now rather than at the first write.
        conn.execute('begin exclusive')
        conn.execute('commit')
    except sqlite3.OperationalError as err:
        conn.close()
        if 'locked' in str(err):
            raise VaultFileError(f'{path.name} is already open in another Cherrion window.') from err
        raise VaultFileError(f'Cannot open {path.name}: {err}.') from err
    except sqlite3.DatabaseError as err:
        conn.close()
        raise VaultFileError(f'{path.name} is not a Cherrion vault file.') from err
    return conn


class VaultFile:
    def __init__(self, path: Path, conn: sqlite3.Connection) -> None:
        self.path = path
        self._conn = conn
        self._lock = threading.Lock()

    # ---- Opening ----

    @classmethod
    def create(cls, path: str | os.PathLike, header: dict, notes: Iterable[dict] = (), meta: dict | None = None) -> 'VaultFile':
        p = Path(path)
        if p.exists():
            raise VaultFileError(f'{p.name} already exists. Choose another name.')
        _check_header(header)
        envelopes = [_check_envelope(e) for e in notes]
        conn = _connect(p, create=True)
        try:
            conn.execute('begin')
            conn.execute(f'pragma application_id = {APPLICATION_ID}')
            conn.execute(f'pragma user_version = {SCHEMA_VERSION}')
            for statement in _SCHEMA.split(';'):
                if statement.strip():
                    conn.execute(statement)
            conn.execute('insert into meta (key, value) values (?, ?)', ('header', _dumps(header)))
            conn.executemany(
                'insert into notes (id, updated_at, deleted, envelope, dirty) values (?, ?, ?, ?, 0)',
                [(e['id'], e['updatedAt'], int(e['deleted']), _dumps(e)) for e in envelopes])
            for key, value in (meta or {}).items():
                if key not in META_KEYS:
                    raise VaultFileError(f'Unknown setting {key}.')
                if value is not None:
                    conn.execute('insert into meta (key, value) values (?, ?)', (key, str(value)))
            conn.execute('commit')
        except BaseException:
            conn.close()
            try:
                p.unlink()
            except OSError:
                pass
            raise
        return cls(p, conn)

    @classmethod
    def open(cls, path: str | os.PathLike) -> 'VaultFile':
        p = Path(path)
        if not p.is_file():
            raise VaultFileError(f'{p.name} was not found. It may have been moved or deleted.')
        conn = _connect(p, create=False)
        try:
            app_id = conn.execute('pragma application_id').fetchone()[0]
            version = conn.execute('pragma user_version').fetchone()[0]
            if app_id != APPLICATION_ID:
                raise VaultFileError(f'{p.name} is not a Cherrion vault file.')
            if version > SCHEMA_VERSION:
                raise VaultFileError(f'{p.name} was saved by a newer version of Cherrion. Update the app to open it.')
            if not conn.execute("select 1 from meta where key = 'header'").fetchone():
                raise VaultFileError(f'{p.name} is damaged: its vault header is missing.')
        except sqlite3.DatabaseError as err:
            conn.close()
            raise VaultFileError(f'{p.name} is not a Cherrion vault file.') from err
        except BaseException:
            conn.close()
            raise
        return cls(p, conn)

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except sqlite3.Error:
                pass

    # ---- Reading ----

    def read(self) -> dict:
        with self._lock:
            meta = dict(self._conn.execute('select key, value from meta').fetchall())
            rows = self._conn.execute('select envelope, dirty from notes').fetchall()
        notes = [json.loads(env) for env, _ in rows]
        dirty = [n['id'] for n, (_, d) in zip(notes, rows) if d]
        sync = None
        if meta.get('sync_url') and meta.get('sync_username'):
            sync = {'url': meta['sync_url'], 'username': meta['sync_username'], 'since': int(meta.get('sync_since') or 0)}
        return {'header': json.loads(meta['header']), 'notes': notes, 'dirty': dirty, 'sync': sync}

    # ---- Writing ----

    def save(self, notes: Iterable[dict] = (), header: dict | None = None, meta: dict | None = None) -> None:
        """Writes changed notes ({envelope, dirty}), the header and settings in one transaction.
        An older copy of a note never replaces a newer one (last write wins, as on the server)."""
        rows = []
        for item in notes:
            env = _check_envelope(item.get('envelope') if isinstance(item, dict) else None)
            rows.append((env['id'], env['updatedAt'], int(env['deleted']), _dumps(env), int(bool(item.get('dirty')))))
        if header is not None:
            _check_header(header)
        for key in (meta or {}):
            if key not in META_KEYS:
                raise VaultFileError(f'Unknown setting {key}.')
        with self._lock:
            self._conn.execute('begin')
            try:
                self._conn.executemany(
                    """insert into notes (id, updated_at, deleted, envelope, dirty) values (?, ?, ?, ?, ?)
                       on conflict (id) do update set updated_at = excluded.updated_at, deleted = excluded.deleted,
                         envelope = excluded.envelope, dirty = excluded.dirty
                       where excluded.updated_at >= notes.updated_at""", rows)
                if header is not None:
                    self._conn.execute("update meta set value = ? where key = 'header'", (_dumps(header),))
                for key, value in (meta or {}).items():
                    if value is None:
                        self._conn.execute('delete from meta where key = ?', (key,))
                    else:
                        self._conn.execute('insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
                                           (key, str(value)))
                self._conn.execute('commit')
            except BaseException:
                self._conn.execute('rollback')
                raise

    def mark_clean(self, sent: Iterable[Any]) -> None:
        """The sync server stored these exact versions ([id, updatedAt] pairs)."""
        pairs = [(str(p[0]), int(p[1])) for p in sent]
        with self._lock:
            self._conn.execute('begin')
            try:
                self._conn.executemany('update notes set dirty = 0 where id = ? and updated_at = ?', pairs)
                self._conn.execute('commit')
            except BaseException:
                self._conn.execute('rollback')
                raise
