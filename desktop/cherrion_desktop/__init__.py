"""Cherrion desktop: the encrypted note app with one local .cherrion file (SQLite), optionally synced."""
try:
    from ._version import __version__  # written by desktop/build.py from package.json
except ImportError:
    __version__ = 'dev'
