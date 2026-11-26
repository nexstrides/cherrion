"""Per-user .cherrion file association on Windows, like CherryTree's .ctb: double-click opens the file.

Everything lives under HKEY_CURRENT_USER\\Software\\Classes, so no admin rights are needed and other
Windows users are not affected:

    .cherrion                          (default) = Cherrion.Vault, OpenWithProgids\\Cherrion.Vault
    Cherrion.Vault                     (default) = Cherrion vault
    Cherrion.Vault\\DefaultIcon         "<exe>",0
    Cherrion.Vault\\shell\\open\\command  "<exe>" "%1"

`classes` can point elsewhere so tests do not touch the real associations.
"""
from __future__ import annotations

import os
import sys

EXT = '.cherrion'
PROG_ID = 'Cherrion.Vault'
CLASSES = r'Software\Classes'

if os.name == 'nt':
    import winreg


def available() -> bool:
    """Only the packaged Cherrion.exe can be registered (from source, the "app" would be python.exe)."""
    return os.name == 'nt' and bool(getattr(sys, 'frozen', False))


def command_for(exe: str) -> str:
    return f'"{exe}" "%1"'


def _read(path: str, name: str = '') -> str | None:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
            value, _ = winreg.QueryValueEx(key, name)
            return value if isinstance(value, str) else None
    except OSError:
        return None


def _write(path: str, value: str, name: str = '') -> None:
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_WRITE) as key:
        winreg.SetValueEx(key, name, 0, winreg.REG_SZ, value)


def _delete_tree(path: str) -> None:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_READ | winreg.KEY_WRITE) as key:
            while True:
                try:
                    child = winreg.EnumKey(key, 0)
                except OSError:
                    break
                _delete_tree(f'{path}\\{child}')
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, path)
    except FileNotFoundError:
        pass


def _notify_shell() -> None:
    """Tells File Explorer to refresh icons and "open with" (SHCNE_ASSOCCHANGED)."""
    try:
        import ctypes
        ctypes.windll.shell32.SHChangeNotify(0x08000000, 0, None, None)
    except (AttributeError, OSError):
        pass


def is_registered(exe: str, classes: str = CLASSES) -> bool:
    """True when .cherrion opens with this exe."""
    return (_read(f'{classes}\\{EXT}') == PROG_ID
            and _read(f'{classes}\\{PROG_ID}\\shell\\open\\command') == command_for(exe))


def register(exe: str, classes: str = CLASSES) -> None:
    _write(f'{classes}\\{EXT}', PROG_ID)
    _write(f'{classes}\\{EXT}\\OpenWithProgids', '', PROG_ID)
    _write(f'{classes}\\{PROG_ID}', 'Cherrion vault')
    _write(f'{classes}\\{PROG_ID}\\DefaultIcon', f'"{exe}",0')
    _write(f'{classes}\\{PROG_ID}\\shell\\open\\command', command_for(exe))
    if classes == CLASSES:
        _notify_shell()


def unregister(classes: str = CLASSES) -> None:
    """Removes Cherrion's registration; leaves .cherrion alone if another app has claimed it."""
    _delete_tree(f'{classes}\\{PROG_ID}')
    if _read(f'{classes}\\{EXT}') == PROG_ID:
        _delete_tree(f'{classes}\\{EXT}')
    if classes == CLASSES:
        _notify_shell()


def refresh(exe: str, classes: str = CLASSES) -> bool:
    """If the user turned the association on earlier but the exe has moved (or was updated in a new
    place), points it at this exe. Never registers on its own. Returns True when it rewrote it."""
    if _read(f'{classes}\\{EXT}') != PROG_ID or is_registered(exe, classes):
        return False
    if _read(f'{classes}\\{PROG_ID}\\shell\\open\\command') is None:
        return False
    register(exe, classes)
    return True
