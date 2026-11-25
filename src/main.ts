import './styles.css';
import { initCrypto } from './crypto';
import { settings } from './settings';
import { wireApp } from './ui/app';
import { showFatal, showLockScreen, wireLockScreen } from './ui/lock';

// Browser storage is per origin. Keep local development on one origin (localhost) so the vault is
// always found, whichever loopback address was typed or printed.
const LOOPBACK_ALIASES = new Set(['127.0.0.1', '[::1]']);

async function boot(): Promise<void> {
  document.body.classList.toggle('dark', settings.dark);
  if (!('indexedDB' in window)) throw new Error('This browser does not provide IndexedDB, which Cherrion needs to store your encrypted notes.');
  wireApp();
  wireLockScreen();
  await initCrypto();
  await showLockScreen();
}

if (LOOPBACK_ALIASES.has(location.hostname)) {
  const url = new URL(location.href);
  url.hostname = 'localhost';
  location.replace(url.href);
} else {
  boot().catch(showFatal);
}
