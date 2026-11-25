// Live 2FA code display: the current code plus a countdown ring, refreshed once per second by one
// shared timer. Widgets drop out on their own when the editor re-renders and removes them.
import { formatCode, secondsRemaining, totpAvailable, totpCode, type TotpParams } from '../totp';
import { el } from './dom';

interface Widget { root: HTMLElement; code: HTMLElement; ring: SVGCircleElement; seconds: HTMLElement; params: TotpParams; counter: number }

const widgets = new Set<Widget>();
let timer = 0;
const SVG = 'http://www.w3.org/2000/svg';

function tick(): void {
  const now = Date.now();
  for (const w of widgets) {
    if (!w.root.isConnected) { widgets.delete(w); continue; }
    const left = secondsRemaining(w.params, now);
    const fraction = left / w.params.period;
    // Snap (no transition) when a new period starts, so the ring refills instead of animating backwards.
    w.ring.style.transition = left === w.params.period ? 'none' : '';
    w.ring.style.strokeDashoffset = String(100 - fraction * 100);
    w.seconds.textContent = String(left);
    w.root.classList.toggle('expiring', left <= 5);
    const counter = Math.floor(now / 1000 / w.params.period);
    if (counter !== w.counter) {
      w.counter = counter;
      totpCode(w.params, now).then(code => {
        if (w.counter === counter) w.code.textContent = formatCode(code);
      }, () => { w.code.textContent = 'Error'; });
    }
  }
  if (!widgets.size) { clearInterval(timer); timer = 0; }
}

export function createTotpDisplay(params: TotpParams, label: string): HTMLElement {
  if (!totpAvailable()) {
    return el('span', { className: 'totp-unavailable', text: '2FA codes need https:// or localhost.' });
  }
  const code = el('span', { className: 'totp-code', text: '••• •••' });
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('class', 'totp-ring');
  svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(SVG, 'circle');
  const ring = document.createElementNS(SVG, 'circle');
  for (const c of [track, ring]) {
    c.setAttribute('cx', '10');
    c.setAttribute('cy', '10');
    c.setAttribute('r', '8');
    c.setAttribute('pathLength', '100');
  }
  track.setAttribute('class', 'totp-ring-track');
  ring.setAttribute('class', 'totp-ring-fill');
  svg.append(track, ring);
  const seconds = el('span', { className: 'totp-seconds' });
  const root = el('div', { className: 'totp' }, code, el('span', { className: 'totp-timer' }, svg, seconds));
  root.setAttribute('aria-label', `${label}: current code`);
  widgets.add({ root, code, ring, seconds, params, counter: -1 });
  timer ||= window.setInterval(tick, 1000);
  queueMicrotask(tick);
  return root;
}

export function stopTotpDisplays(): void {
  widgets.clear();
  clearInterval(timer);
  timer = 0;
}
