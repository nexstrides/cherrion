"""System tray icon (Windows): the 🍒 icon by the clock, with Open / Lock / Exit, for when the window
is hidden instead of closed. Uses Windows Forms' NotifyIcon through pythonnet, which pywebview already
loads, so there is no extra dependency.

WinForms objects must be created and used on the window's UI thread, so everything goes through
form.Invoke. Menu handlers start a Python thread for their work: calling back into the page
(evaluate_js) from the UI thread would deadlock.
"""
from __future__ import annotations

import threading
from typing import Callable

import clr  # noqa: F401  (pythonnet, loaded by pywebview)

clr.AddReference('System.Windows.Forms')
clr.AddReference('System.Drawing')
import System.Windows.Forms as WinForms  # noqa: E402
from System import Func, Type  # noqa: E402
from System.Drawing import Font, FontStyle, Icon, SystemIcons  # noqa: E402


def _in_thread(fn: Callable[[], None]) -> Callable[..., None]:
    return lambda *_args: threading.Thread(target=fn, daemon=True).start()


class Tray:
    def __init__(self, form, icon_path: str | None, on_open: Callable[[], None], on_lock: Callable[[], None], on_exit: Callable[[], None]) -> None:
        self._form = form
        self._icon_path = icon_path
        self._handlers = (on_open, on_lock, on_exit)
        self._icon = None
        self._told = False

    def _invoke(self, fn: Callable[[], None]) -> None:
        if self._form.InvokeRequired:
            self._form.Invoke(Func[Type](fn))
        else:
            fn()

    def show(self) -> None:
        """Shows the tray icon (once), and the first time explains that the app is still running."""
        def make() -> None:
            if self._icon is None:
                on_open, on_lock, on_exit = self._handlers
                icon = WinForms.NotifyIcon()
                icon.Icon = Icon(self._icon_path) if self._icon_path else SystemIcons.Application
                icon.Text = 'Cherrion'
                menu = WinForms.ContextMenuStrip()
                for title, handler in (('Open Cherrion', on_open), ('Lock', on_lock), ('Exit', on_exit)):
                    item = WinForms.ToolStripMenuItem(title)
                    item.Click += _in_thread(handler)
                    if handler is on_open:  # the default action (double-click) is shown in bold
                        item.Font = Font(item.Font, FontStyle.Bold)
                    menu.Items.Add(item)
                icon.ContextMenuStrip = menu
                icon.DoubleClick += _in_thread(on_open)
                icon.BalloonTipClicked += _in_thread(on_open)
                self._icon = icon
            self._icon.Visible = True
            if not self._told:
                self._told = True
                self._icon.ShowBalloonTip(4000, 'Cherrion is still running',
                                          'Double-click the cherry icon to open it again, or right-click it to exit.',
                                          WinForms.ToolTipIcon.Info)
        self._invoke(make)

    def dispose(self) -> None:
        def remove() -> None:
            if self._icon is not None:
                self._icon.Visible = False
                self._icon.Dispose()
                self._icon = None
        try:
            self._invoke(remove)
        except Exception:  # noqa: BLE001 - the window may already be gone
            pass
