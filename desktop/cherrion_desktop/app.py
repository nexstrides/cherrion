"""The desktop window: pywebview (WebView2 on Windows) showing the same front end as the web version,
with a Python bridge for the vault file, native file dialogs and the sync server."""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any

import webview

from . import __version__, remote, winassoc
from .server import serve
from .vaultfile import EXTENSION, VaultFile, VaultFileError

DEFAULT_SYNC_URL = 'https://cherrion-note.vercel.app'
FILE_TYPES = (f'Cherrion vault (*{EXTENSION})', 'All files (*.*)')
MAX_RECENT = 8


def data_dir() -> Path:
    base = os.environ.get('APPDATA') or os.environ.get('XDG_CONFIG_HOME') or str(Path.home() / '.config')
    path = Path(base) / 'Cherrion'
    path.mkdir(parents=True, exist_ok=True)
    return path


def icon_path() -> str | None:
    """The 🍒 app icon: bundled next to the code by PyInstaller, or desktop/assets/ in the repo."""
    for candidate in (Path(getattr(sys, '_MEIPASS', '')) / 'cherrion.ico',
                      Path(__file__).resolve().parents[1] / 'assets' / 'cherrion.ico'):
        if candidate.is_file():
            return str(candidate)
    return None


def set_windows_app_id() -> None:
    """Groups the window under Cherrion's own taskbar icon (not python.exe's) when run from source."""
    if os.name == 'nt':
        try:
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID('Cherrion.Desktop')
        except (AttributeError, OSError):
            pass


def web_root() -> Path:
    """The built front end: bundled next to the code by PyInstaller, or dist-desktop/ in the repo."""
    bundled = Path(getattr(sys, '_MEIPASS', '')) / 'web'
    if bundled.is_dir():
        return bundled
    return Path(__file__).resolve().parents[2] / 'dist-desktop'


class Config:
    """Device preferences that are not secret: recently opened files."""

    def __init__(self, path: Path) -> None:
        self._path = path
        try:
            data = json.loads(path.read_text('utf-8'))
        except (OSError, ValueError):
            data = {}
        recent = data.get('recent') if isinstance(data, dict) else None
        self.recent: list[str] = [p for p in recent if isinstance(p, str)] if isinstance(recent, list) else []

    def remember(self, path: Path) -> None:
        text = str(path)
        self.recent = [text] + [p for p in self.recent if os.path.normcase(p) != os.path.normcase(text)]
        del self.recent[MAX_RECENT:]
        self._save()

    def forget(self, path: str) -> None:
        self.recent = [p for p in self.recent if os.path.normcase(p) != os.path.normcase(path)]
        self._save()

    def _save(self) -> None:
        tmp = self._path.with_suffix('.tmp')
        tmp.write_text(json.dumps({'recent': self.recent}, indent=2), 'utf-8')
        os.replace(tmp, self._path)


class Api:
    """Methods the page calls as window.pywebview.api.<name>(...). Names starting with _ are private."""

    def __init__(self, config: Config, launch_file: str | None = None) -> None:
        self._config = config
        self._vault: VaultFile | None = None
        self._window: Any = None
        self._lock = threading.Lock()
        self._close_ok = False
        self._launch_file = launch_file

    # ---- App ----

    def app_info(self) -> dict:
        return {
            'version': __version__,
            'recent': [p for p in self._config.recent if Path(p).is_file()],
            'defaultSyncUrl': DEFAULT_SYNC_URL,
            # A .cherrion file double-clicked in File Explorer (or passed on the command line).
            'launchFile': self._launch_file,
        }

    def forget_recent(self, path: str) -> None:
        self._config.forget(path)

    # ---- Double-click to open .cherrion files (Windows, per user) ----

    def file_association(self) -> dict:
        ok = winassoc.available()
        return {'available': ok, 'enabled': ok and winassoc.is_registered(sys.executable)}

    def set_file_association(self, enabled: bool) -> dict:
        if not winassoc.available():
            raise VaultFileError('Only the installed Cherrion.exe can open .cherrion files on double-click.')
        if enabled:
            winassoc.register(sys.executable)
        else:
            winassoc.unregister()
        return self.file_association()

    # ---- File dialogs ----

    def pick_open(self) -> str | None:
        result = self._window.create_file_dialog(webview.FileDialog.OPEN, file_types=FILE_TYPES)
        return str(result[0]) if result else None

    def pick_save(self, suggested: str) -> str | None:
        name = Path(str(suggested or 'My notes')).name
        if not name.lower().endswith(EXTENSION):
            name += EXTENSION
        result = self._window.create_file_dialog(webview.FileDialog.SAVE, save_filename=name, file_types=FILE_TYPES)
        if not result:
            return None
        path = str(result if isinstance(result, str) else result[0])
        return path if path.lower().endswith(EXTENSION) else path + EXTENSION

    def save_text(self, suggested: str, text: str) -> str | None:
        """Save dialog for exports (recovery key, encrypted backup)."""
        name = Path(str(suggested or 'cherrion.txt')).name
        ext = Path(name).suffix or '.txt'
        result = self._window.create_file_dialog(
            webview.FileDialog.SAVE, save_filename=name, file_types=(f'{ext[1:].upper()} file (*{ext})', 'All files (*.*)'))
        if not result:
            return None
        path = Path(result if isinstance(result, str) else result[0])
        path.write_text(str(text), 'utf-8')
        return str(path)

    # ---- Vault file ----

    def vault_create(self, path: str, header: dict, notes: list, sync: dict | None = None) -> dict:
        meta = {}
        if sync:
            meta = {'sync_url': remote.normalize_base_url(sync.get('url', '')), 'sync_username': str(sync.get('username', '')),
                    'sync_since': int(sync.get('since') or 0)}
        with self._lock:
            self._close_current()
            self._vault = VaultFile.create(path, header, notes, meta)
            self._config.remember(self._vault.path)
            return {'path': str(self._vault.path)}

    def vault_open(self, path: str) -> dict:
        with self._lock:
            self._close_current()
            try:
                self._vault = VaultFile.open(path)
            except VaultFileError:
                if not Path(path).is_file():
                    self._config.forget(path)
                raise
            self._config.remember(self._vault.path)
            return {'path': str(self._vault.path), **self._vault.read()}

    def vault_save(self, changes: dict) -> None:
        vault = self._require()
        vault.save(changes.get('notes') or [], changes.get('header'), changes.get('meta'))

    def vault_mark_clean(self, sent: list) -> None:
        self._require().mark_clean(sent)

    def vault_close(self) -> None:
        with self._lock:
            self._close_current()

    def _require(self) -> VaultFile:
        if not self._vault:
            raise VaultFileError('No vault file is open.')
        return self._vault

    def _close_current(self) -> None:
        if self._vault:
            self._vault.close()
            self._vault = None

    # ---- Sync server ----

    def http_post(self, base_url: str, endpoint: str, body: str, token: str | None = None) -> dict:
        return remote.post(base_url, endpoint, body, token)

    # ---- Window lifecycle ----

    def _on_closing(self) -> bool:
        """Lets the page write its last edits to the file before the window goes away."""
        if self._close_ok:
            return True
        threading.Thread(target=self._finish_and_close, daemon=True).start()
        return False

    def _finish_and_close(self) -> None:
        try:
            self._window.evaluate_js('window.__cherrionBeforeClose ? window.__cherrionBeforeClose() : 0')
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if not self._window.evaluate_js('window.__cherrionBusy ? window.__cherrionBusy() : false'):
                    break
                time.sleep(0.1)
        except Exception:  # noqa: BLE001 - closing must not fail
            pass
        finally:
            self._close_ok = True
            self.vault_close()
            self._window.destroy()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog='cherrion', description='Cherrion desktop')
    parser.add_argument('file', nargs='?', help='a .cherrion vault file to open (File Explorer passes it on double-click)')
    parser.add_argument('--dev', metavar='URL', nargs='?', const='http://127.0.0.1:5173/',
                        help='load the Vite dev server (npm run dev:desktop) instead of the built files')
    parser.add_argument('--debug', action='store_true', help='enable developer tools')
    args = parser.parse_args(argv)
    launch_file = str(Path(args.file).resolve()) if args.file and Path(args.file).is_file() else None

    # The user turned on double-click earlier and this exe has moved or been updated: follow it.
    if winassoc.available():
        try:
            winassoc.refresh(sys.executable)
        except OSError:
            pass

    if args.dev:
        url = args.dev
    else:
        root = web_root()
        if not (root / 'index.html').is_file():
            sys.exit(f'Front end not built: {root} is missing. Run `npm run build:desktop` first.')
        url = serve(root)

    set_windows_app_id()
    home = data_dir()
    api = Api(Config(home / 'desktop.json'), launch_file)
    window = webview.create_window('Cherrion', url, js_api=api, width=1280, height=820, min_size=(420, 520), text_select=True)
    api._window = window
    window.events.closing += api._on_closing
    # Not private mode, so the page keeps its preferences; notes are never stored in the browser.
    webview.start(debug=args.debug, private_mode=False, storage_path=str(home / 'WebView'), icon=icon_path())
