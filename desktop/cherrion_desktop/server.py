"""Serves the built front end (dist-desktop/) to the app window on a fixed loopback port.

A fixed port keeps the page's origin stable between runs, so its preferences (theme, auto-lock) are
remembered. Only static files are served: notes and keys never pass through this server.
"""
from __future__ import annotations

import functools
import hmac
import http.server
import json
import socket
import threading
from pathlib import Path
from typing import Callable

PORTS = range(47219, 47229)

# Windows' registry can map .js to text/plain, which browsers refuse for module scripts.
_TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '': 'application/octet-stream',
}


class _Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = _TYPES

    def do_GET(self) -> None:  # noqa: N802 - http.server naming
        # Only answer for our own origin (blocks DNS-rebinding pages from reading the files).
        if self.headers.get('Host', '') not in getattr(self.server, 'allowed_hosts', ()):
            self.send_error(403)
            return
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_POST(self) -> None:  # noqa: N802
        """POST /__cherrion/activate from a second start of the app (see instance.py): show this
        window. Needs the random token from instance.json, which only this user's processes can read."""
        server = self.server
        token = getattr(server, 'activate_token', None)
        handler = getattr(server, 'on_activate', None)
        if (self.path != '/__cherrion/activate' or not token or not handler
                or self.headers.get('Host', '') not in getattr(server, 'allowed_hosts', ())
                or not hmac.compare_digest(self.headers.get('X-Cherrion-Token', ''), token)):
            self.send_error(403)
            return
        length = min(int(self.headers.get('Content-Length') or 0), 64 * 1024)
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            body = {}
        file = body.get('file') if isinstance(body, dict) and isinstance(body.get('file'), str) else None
        threading.Thread(target=handler, args=(file,), daemon=True).start()
        self.send_response(204)
        self.end_headers()

    def end_headers(self) -> None:
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        super().end_headers()

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - quiet
        pass


class _ExclusiveServer(http.server.ThreadingHTTPServer):
    """Owns its port alone. http.server turns on SO_REUSEADDR, which on Windows lets a second process
    bind the same port and take its connections: another Cherrion window (possibly an older version)
    would then serve this window's page, or another program could show a fake unlock screen."""
    allow_reuse_address = False

    def server_bind(self) -> None:
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def serve(root: Path, on_activate: Callable[[str | None], None] | None = None, activate_token: str | None = None) -> str:
    """Starts the server in a background thread and returns its URL. With `on_activate`, a second
    start of the app can bring this one back (POST /__cherrion/activate with `activate_token`)."""
    last_error: OSError | None = None
    for port in PORTS:
        handler = functools.partial(_Handler, directory=str(root))
        try:
            httpd = _ExclusiveServer(('127.0.0.1', port), handler)
        except OSError as err:
            last_error = err
            continue
        httpd.allowed_hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}  # type: ignore[attr-defined]
        httpd.on_activate = on_activate  # type: ignore[attr-defined]
        httpd.activate_token = activate_token  # type: ignore[attr-defined]
        threading.Thread(target=httpd.serve_forever, name='cherrion-static', daemon=True).start()
        return f'http://127.0.0.1:{port}/'
    raise OSError(f'No free port for the Cherrion window ({last_error}).')
