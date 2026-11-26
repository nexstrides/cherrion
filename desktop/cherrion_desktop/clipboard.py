"""Reads text from the Windows clipboard (for the right-click menu's Paste)."""
from __future__ import annotations

import os
import time

CF_UNICODETEXT = 13


def read_text() -> str:
    if os.name != 'nt':
        return ''
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL('user32', use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.OpenClipboard.restype = wintypes.BOOL
    user32.CloseClipboard.restype = wintypes.BOOL
    user32.GetClipboardData.argtypes = [wintypes.UINT]
    user32.GetClipboardData.restype = wintypes.HANDLE
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = wintypes.LPVOID
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]

    # Another program may hold the clipboard for a moment.
    for _ in range(10):
        if user32.OpenClipboard(None):
            break
        time.sleep(0.02)
    else:
        return ''
    try:
        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return ''
        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            return ''
        try:
            return ctypes.wstring_at(pointer)
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()
