// Scanning a 2FA setup QR code: from a screenshot (paste it, drop it, or choose the file), the camera,
// or (website, desktop browsers) a capture of the screen. jsQR decodes it here, loaded only when the
// scanner opens; images and camera frames never leave the device, and the camera stops as soon as a
// code is found or the dialog closes.
import { DESKTOP } from '../platform';
import { parseTotp } from '../totp';
import { el } from './dom';

type Decode = (data: Uint8ClampedArray, width: number, height: number, options?: { inversionAttempts?: string }) => { data: string } | null;
let decoder: Promise<Decode> | null = null;
const loadDecoder = (): Promise<Decode> => (decoder ??= import('jsqr').then(m => m.default as unknown as Decode));

/** The first QR code in an image (tried at a size that keeps decoding quick, then full size). */
export async function decodeQr(source: CanvasImageSource, width: number, height: number): Promise<string | null> {
  const decode = await loadDecoder();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || !width || !height) return null;
  for (const maxSide of [1600, 4000]) {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const found = decode(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (found?.data) return found.data;
    if (scale === 1) break;
  }
  return null;
}

async function decodeFile(file: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(file);
  try { return await decodeQr(bitmap, bitmap.width, bitmap.height); } finally { bitmap.close(); }
}

const NOT_2FA = 'That QR code is not a 2FA setup code. Use the one from the site’s two-factor (authenticator app) setup page.';

let active: { finish(result: string | null): void } | null = null;

/** Closes the scanner (also used when locking). */
export function closeQrScan(): void { active?.finish(null); }

/** Opens the scanner; resolves with the QR code's text (an otpauth:// link or a key), or null. */
export function scanQrCode(): Promise<string | null> {
  closeQrScan();
  return new Promise(resolve => {
    const streams: MediaStream[] = [];
    let timer: ReturnType<typeof setInterval> | null = null;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const error = el('p', { className: 'form-error hidden' });
    error.setAttribute('role', 'alert');
    const status = el('p', { className: 'muted small qr-status' });
    const fail = (message: string) => { error.textContent = message; error.classList.remove('hidden'); status.textContent = ''; };
    const working = (message: string) => { error.classList.add('hidden'); status.textContent = message; };

    const accept = (text: string | null, where: string): boolean => {
      if (!text) { fail(`No QR code found ${where}. Make sure the whole code is visible and sharp.`); return false; }
      if (!parseTotp(text)) { fail(NOT_2FA); return false; }
      finish(text);
      return true;
    };
    const tryFile = async (file: File | undefined) => {
      if (!file) return;
      if (!file.type.startsWith('image/')) { fail('Use a picture (a screenshot or a photo of the QR code).'); return; }
      working('Reading the picture…');
      try { accept(await decodeFile(file), 'in that picture'); } catch { fail('That picture could not be read.'); }
    };

    const video = el('video', { className: 'qr-video hidden', muted: true, playsInline: true, autoplay: true });
    const stopCamera = () => {
      if (timer) { clearInterval(timer); timer = null; }
      for (const s of streams.splice(0)) for (const t of s.getTracks()) t.stop();
      video.srcObject = null;
      video.classList.add('hidden');
      cameraButton.textContent = '📷 Use camera';
    };
    const startCamera = async () => {
      if (streams.length) { stopCamera(); return; }
      working('Starting the camera…');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (!active) { for (const t of stream.getTracks()) t.stop(); return; }
        streams.push(stream);
        video.srcObject = stream;
        video.classList.remove('hidden');
        cameraButton.textContent = '■ Stop camera';
        working('Point the camera at the QR code…');
        let busy = false;
        timer = setInterval(async () => {
          if (busy || video.readyState < 2) return;
          busy = true;
          try {
            const text = await decodeQr(video, video.videoWidth, video.videoHeight);
            if (text && !parseTotp(text)) fail(NOT_2FA);
            else if (text) finish(text);
          } finally { busy = false; }
        }, 300);
      } catch {
        fail(DESKTOP ? 'The camera is not available in the desktop app. Paste a screenshot of the QR code instead (Ctrl+V).'
          : 'The camera could not be used (no camera, or permission was not given). Paste a screenshot instead (Ctrl+V).');
      }
    };
    const captureScreen = async () => {
      working('Choose the screen or window that shows the QR code…');
      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        const frame = el('video', { muted: true, playsInline: true });
        frame.srcObject = stream;
        await frame.play();
        await new Promise(r => setTimeout(r, 300)); // let a full frame arrive
        working('Looking for the QR code…');
        accept(await decodeQr(frame, frame.videoWidth, frame.videoHeight), 'on the captured screen');
        frame.srcObject = null;
      } catch {
        fail('The screen could not be captured. Paste a screenshot instead (Ctrl+V).');
      } finally {
        for (const t of stream?.getTracks() ?? []) t.stop();
      }
    };

    const fileInput = el('input', { type: 'file', accept: 'image/*', className: 'hidden' });
    fileInput.onchange = () => { void tryFile(fileInput.files?.[0]); fileInput.value = ''; };
    const chooseButton = el('button', { type: 'button', className: 'action-btn', text: '🖼️ Choose a picture…', onclick: () => fileInput.click() });
    const cameraButton = el('button', { type: 'button', className: 'action-btn', text: '📷 Use camera', onclick: () => void startCamera() });
    const screenButton = el('button', { type: 'button', className: 'action-btn', text: '🖥️ Capture screen', onclick: () => void captureScreen() });
    const canCamera = !!navigator.mediaDevices?.getUserMedia;
    const canScreen = !DESKTOP && !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad/i.test(navigator.userAgent);

    const drop = el('div', { className: 'qr-drop', tabIndex: 0 },
      el('div', { className: 'qr-drop-icon', text: '⌗' }),
      el('div', { className: 'qr-drop-text' },
        el('strong', { text: 'Paste a screenshot of the QR code (Ctrl+V)' }),
        el('span', { className: 'muted small', text: 'or drop a picture here' })));
    drop.setAttribute('aria-label', 'Paste or drop a picture of the QR code here');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); void tryFile(e.dataTransfer?.files[0]); });

    const close = el('button', { type: 'button', text: '✕', onclick: () => finish(null) });
    close.setAttribute('aria-label', 'Close');
    const card = el('div', { className: 'modal-card qr-card' },
      el('div', { className: 'modal-header' }, el('h3', { text: 'Scan the 2FA QR code' }), close),
      el('p', { className: 'muted small', text: 'Use the QR code from the site’s two-factor setup page (“set up an authenticator app”). It is read on this device only.' }),
      drop,
      el('div', { className: 'qr-actions' }, chooseButton, ...(canCamera ? [cameraButton] : []), ...(canScreen ? [screenButton] : []), fileInput),
      video, status, error);
    const modal = el('div', { className: 'modal qr-modal' }, card);
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Scan the 2FA QR code');

    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find(f => f.type.startsWith('image/'));
      if (!file) {
        const text = e.clipboardData?.getData('text') ?? '';
        if (text.trim()) { e.preventDefault(); accept(text.trim(), 'in the pasted text'); }
        return;
      }
      e.preventDefault();
      void tryFile(file);
    };
    modal.addEventListener('mousedown', e => { if (e.target === modal) finish(null); });
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); } });

    function finish(result: string | null): void {
      if (active?.finish !== finish) return;
      active = null;
      stopCamera();
      document.removeEventListener('paste', onPaste, true);
      modal.remove();
      if (returnFocus?.isConnected) returnFocus.focus();
      resolve(result);
    }

    active = { finish };
    document.body.append(modal);
    document.addEventListener('paste', onPaste, true);
    void loadDecoder(); // start fetching the decoder now
    drop.focus();
  });
}
