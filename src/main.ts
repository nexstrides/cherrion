import './styles.css';
import { initCrypto } from './crypto';
import { startBridge } from './desktop/bridge';
import { DESKTOP } from './platform';
import { settings } from './settings';
import { wireApp } from './ui/app';
import { wireContextMenus } from './ui/contextMenu';
import { hydrateIcons } from './ui/dom';
import { showDesktopStart, wireDesktop } from './ui/desktop';
import { showFatal, showLockScreen, wireLockScreen } from './ui/lock';
import { captureJoinLink } from './ui/workspaces';

// Browser storage is per origin. Keep local development on one origin (localhost) so the vault is
// always found, whichever loopback address was typed or printed.
const LOOPBACK_ALIASES = new Set(['127.0.0.1', '[::1]']);

async function boot(): Promise<void> {
  document.body.classList.toggle('dark', settings.dark);
  hydrateIcons();
  wireApp();
  if (DESKTOP) {
    // WebView2 lists Document Picture-in-Picture but refuses to open it, so no floating stickies here yet.
    document.body.classList.add('desktop', 'no-popout');
    wireDesktop();
    wireContextMenus();
    await initCrypto();
    await startBridge();
    await showDesktopStart();
    return;
  }
  if (!('indexedDB' in window)) throw new Error('This browser does not provide IndexedDB, which Cherrion needs to store your encrypted notes.');
  wireLockScreen();
  await initCrypto();
  await showLockScreen();
  captureJoinLink(); // an invite link (#join=…): joined after logging in
}

if (!DESKTOP && LOOPBACK_ALIASES.has(location.hostname)) {
  const url = new URL(location.href);
  url.hostname = 'localhost';
  location.replace(url.href);
} else {
  boot().catch(showFatal);
}
