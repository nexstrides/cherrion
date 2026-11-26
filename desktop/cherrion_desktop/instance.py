"""One Cherrion window per user: a second start (from the Start menu, or a double-clicked .cherrion
file) brings the running window back, even from the tray, instead of opening another one.

The running app writes instance.json (its local port and a random token) in the user's app-data
folder. A new start reads it and POSTs to /__cherrion/activate; if that works, it exits.
"""
from __future__ import annotations

import json
import os
import secrets
import urllib.request
from pathlib import Path

FILE = 'instance.json'
# Local requests only: never through a proxy.
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def activate_existing(home: Path, launch_file: str | None) -> bool:
    """True if a running Cherrion took over (this start should then exit)."""
    try:
        info = json.loads((home / FILE).read_text('utf-8-sig'))
        port, token = int(info['port']), str(info['token'])
    except (OSError, ValueError, KeyError, TypeError):
        return False
    request = urllib.request.Request(
        f'http://127.0.0.1:{port}/__cherrion/activate',
        data=json.dumps({'file': launch_file}).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'X-Cherrion-Token': token},
        method='POST',
    )
    try:
        with _opener.open(request, timeout=3) as res:
            return res.status == 204
    except OSError:
        return False  # not running any more (stale file), or another program on that port


def new_token() -> str:
    return secrets.token_urlsafe(24)


def register(home: Path, url: str, token: str) -> None:
    port = int(url.rstrip('/').rsplit(':', 1)[1])
    tmp = home / f'{FILE}.tmp'
    tmp.write_text(json.dumps({'port': port, 'token': token, 'pid': os.getpid()}), 'utf-8')
    os.replace(tmp, home / FILE)


def unregister(home: Path, token: str) -> None:
    """Removes instance.json if it is still ours."""
    path = home / FILE
    try:
        if json.loads(path.read_text('utf-8')).get('token') == token:
            path.unlink()
    except (OSError, ValueError):
        pass
