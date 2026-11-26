"""Packages the desktop app into one executable with PyInstaller: desktop/dist/Cherrion(.exe).

Run `npm run desktop:package` (it builds the front end into dist-desktop/ first).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import PyInstaller.__main__

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
WEB = ROOT / 'dist-desktop'
# The web app's 🍒 favicon as a Windows icon (16–256 px).
ICON = HERE / 'assets' / 'cherrion.ico'


def main() -> None:
    if not (WEB / 'index.html').is_file():
        sys.exit('dist-desktop/ is missing: run `npm run build:desktop` first.')
    # One version for web and desktop: package.json's.
    version = json.loads((ROOT / 'package.json').read_text('utf-8'))['version']
    (HERE / 'cherrion_desktop' / '_version.py').write_text(f"__version__ = '{version}'\n", 'utf-8')
    PyInstaller.__main__.run([
        str(HERE / 'main.py'),
        '--name', 'Cherrion',
        '--onefile',
        '--windowed',
        '--noconfirm',
        '--clean',
        '--paths', str(HERE),
        '--icon', str(ICON),
        '--add-data', f'{WEB}{os.pathsep}web',
        '--add-data', f'{ICON}{os.pathsep}.',
        '--distpath', str(HERE / 'dist'),
        '--workpath', str(HERE / 'build'),
        '--specpath', str(HERE / 'build'),
    ])
    exe = HERE / 'dist' / ('Cherrion.exe' if os.name == 'nt' else 'Cherrion')
    print(f'\nBuilt {exe} ({exe.stat().st_size / 1e6:.1f} MB), version {version}')


if __name__ == '__main__':
    main()
