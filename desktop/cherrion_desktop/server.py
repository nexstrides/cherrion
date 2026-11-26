"""Serves the built front end (dist-desktop/) to the app window on a fixed loopback port.

A fixed port keeps the page's origin stable between runs, so its preferences (theme, auto-lock) are
remembered. Only static files are served: notes and keys never pass through this server.
"""
from __future__ import annotations

import functools
import http.server
import threading
from pathlib import Path

PORTS = range(47219, 47229)

# Windows' registry can map .js to text/plain, which browsers refuse for module scripts.
_TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '': 'application/octet-stream',
}


class _Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = _TYPES
    allowed_hosts: set[str] = set()

    def do_GET(self) -> None:  # noqa: N802 - http.server naming
        # Only answer for our own origin (blocks DNS-rebinding pages from reading the files).
        if self.headers.get('Host', '') not in self.allowed_hosts:
            self.send_error(403)
            return
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def end_headers(self) -> None:
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        super().end_headers()

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - quiet
        pass


def serve(root: Path) -> str:
    """Starts the server in a background thread and returns its URL."""
    last_error: OSError | None = None
    for port in PORTS:
        handler = functools.partial(_Handler, directory=str(root))
        try:
            httpd = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
        except OSError as err:
            last_error = err
            continue
        _Handler.allowed_hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}
        threading.Thread(target=httpd.serve_forever, name='cherrion-static', daemon=True).start()
        return f'http://127.0.0.1:{port}/'
    raise OSError(f'No free port for the Cherrion window ({last_error}).')
