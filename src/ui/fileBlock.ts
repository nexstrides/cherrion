// Attached file blocks: the file's type, name and size, an optional note, and a Download button.
// The content is fetched and decrypted only when downloading (see src/files.ts).
import { ApiError } from '../api';
import { fileIcon, formatBytes, openFile } from '../files';
import { FILE_TYPES, fileExtension, type FileBlock, type Note } from '../model';
import * as store from '../store';
import { autoResize, downloadBytes, el, ICONS, setWorking, svgIcon, toast } from './dom';

/** The system file picker, limited to the types that can be attached. */
export function chooseFiles(): Promise<File[]> {
  return new Promise(resolve => {
    const input = el('input', { type: 'file', accept: FILE_TYPES.map(t => `.${t}`).join(','), multiple: true });
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

export const fileErrorMessage = (err: unknown): string =>
  err instanceof ApiError && err.status === 0 ? 'Files need a connection to the Cherrion server. Try again when you are online.'
    : err instanceof Error ? err.message : String(err);

export async function downloadFileBlock(block: FileBlock, button?: HTMLButtonElement): Promise<void> {
  const restore = button ? setWorking(button, 'Downloading…') : null;
  if (button) button.disabled = true;
  try {
    const bytes = await openFile(block);
    await downloadBytes(block.name, bytes, block.mime || 'application/octet-stream');
  } catch (err) {
    toast(fileErrorMessage(err), 'error', 8000);
  } finally {
    restore?.();
    if (button) button.disabled = false;
  }
}

export function renderFileBlock(note: Note, block: FileBlock, body: HTMLElement): void {
  const download = el('button', { type: 'button', className: 'primary-btn file-download', title: `Download “${block.name}”` },
    svgIcon(ICONS.download), 'Download');
  download.onclick = () => void downloadFileBlock(block, download);
  const noteInput = el('textarea', { className: 'file-note', value: block.note, rows: 1, placeholder: 'Add a note…', maxLength: 2000 });
  noteInput.setAttribute('aria-label', `Note for ${block.name}`);
  noteInput.addEventListener('input', () => { block.note = noteInput.value; autoResize(noteInput); store.touchNote(note); });
  requestAnimationFrame(() => autoResize(noteInput));
  const type = fileExtension(block.name).toUpperCase() || 'File';
  body.append(el('div', { className: 'file-card' },
    el('span', { className: 'file-icon', text: fileIcon(block.name), title: type }),
    el('div', { className: 'file-main' },
      el('div', { className: 'file-name', text: block.name, title: block.name }),
      el('div', { className: 'file-meta', text: `${type} · ${formatBytes(block.size)}` }),
      noteInput,
    ),
    download,
  ));
}
