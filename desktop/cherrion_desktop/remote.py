"""Talks to a Cherrion sync server (the web version's /api) on behalf of the app window.

Requests go from Python rather than from the page, so the server needs no CORS rules and the page's
Content-Security-Policy can stay `connect-src 'self'`. Only the known endpoints can be called, only
over HTTPS (plain HTTP only for a server on this computer), and redirects are not followed, so the
session token is never sent anywhere but the configured server.
"""
from __future__ import annotations

import json
import socket
import ssl
import urllib.error
import urllib.request
from urllib.parse import urlsplit, urlunsplit

ENDPOINTS = {'prelogin', 'signup', 'login', 'recover', 'account', 'sync', 'logout', 'status'}
LOCAL_HOSTS = {'localhost', '127.0.0.1', '::1'}
USER_AGENT = 'Cherrion-Desktop'
TIMEOUT = 30


class RemoteError(Exception):
    pass


def normalize_base_url(url: str) -> str:
    """'cherrion-note.vercel.app' -> 'https://cherrion-note.vercel.app'. Raises RemoteError."""
    text = (url or '').strip()
    if not text:
        raise RemoteError('Enter the sync server address.')
    if '://' not in text:
        text = 'https://' + text
    parts = urlsplit(text)
    host = (parts.hostname or '').lower()
    if not host or parts.username or parts.password:
        raise RemoteError('That is not a valid server address.')
    if parts.scheme == 'http' and host not in LOCAL_HOSTS:
        raise RemoteError('The sync server must use HTTPS.')
    if parts.scheme not in ('https', 'http'):
        raise RemoteError('The sync server must use HTTPS.')
    path = parts.path.rstrip('/')
    return urlunsplit((parts.scheme, parts.netloc.lower(), path, '', ''))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401 - urllib hook
        return None


_opener = urllib.request.build_opener(_NoRedirect, urllib.request.HTTPSHandler(context=ssl.create_default_context()))


def post(base_url: str, endpoint: str, body: str, token: str | None = None) -> dict:
    """POSTs JSON to {base}/api/{endpoint}. Returns {'status', 'data'}; status 0 means unreachable."""
    if endpoint not in ENDPOINTS:
        raise RemoteError('Unknown API endpoint.')
    if not isinstance(body, str):
        raise RemoteError('Request body must be JSON text.')
    url = f'{normalize_base_url(base_url)}/api/{endpoint}'
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': USER_AGENT}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    request = urllib.request.Request(url, data=body.encode('utf-8'), headers=headers, method='POST')
    try:
        with _opener.open(request, timeout=TIMEOUT) as res:
            return {'status': res.status, 'data': _json(res.read())}
    except urllib.error.HTTPError as err:
        return {'status': err.code, 'data': _json(err.read())}
    except (urllib.error.URLError, socket.timeout, ConnectionError, ssl.SSLError, OSError) as err:
        reason = getattr(err, 'reason', err)
        if isinstance(reason, ssl.SSLCertVerificationError) or isinstance(err, ssl.SSLError):
            return {'status': 0, 'data': {'error': f'Secure connection to the sync server failed: {reason}'}}
        return {'status': 0, 'data': {}}


def _json(raw: bytes) -> dict:
    try:
        data = json.loads(raw.decode('utf-8') or '{}')
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}
