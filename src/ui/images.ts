// Pictures in pages. A picture is shrunk (longest side ≤ 1600 px) and re-encoded as WebP before it is
// stored in the page, so it is encrypted and synced with the rest of the page and stays small.
// Pictures can be added with "/picture", pasted from the clipboard, or dropped onto the page.
import { IMAGE_LIMITS, pictureBytes, uid, type Block, type ImageBlock, type Note } from '../model';
import * as store from '../store';
import { el, toast } from './dom';

const ACCEPTED = /^image\/(png|jpeg|webp|gif|bmp)$/;
const mb = (chars: number) => `${(chars * 0.75 / 1_000_000).toFixed(1)} MB`;

/** Shrinks and compresses a picture file into an image block (throws a message for the user). */
export async function pictureFromFile(file: Blob): Promise<ImageBlock> {
  if (!ACCEPTED.test(file.type)) throw new Error('Only PNG, JPEG, WebP, GIF or BMP pictures can be added.');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('That picture could not be read.'); }
  try {
    let scale = Math.min(1, IMAGE_LIMITS.maxSide / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 6; attempt++) {
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = el('canvas', { width, height });
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('This window cannot process pictures.');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, width, height);
      for (const quality of [0.86, 0.75, 0.62]) {
        let src = canvas.toDataURL('image/webp', quality);
        if (!src.startsWith('data:image/webp')) src = canvas.toDataURL('image/jpeg', quality); // no WebP encoder
        if (src.length <= IMAGE_LIMITS.maxSrc) return { id: uid(), type: 'image', src, width, height, caption: '' };
      }
      scale *= 0.75;
    }
    throw new Error('That picture is too large to add, even after shrinking it.');
  } finally {
    bitmap.close();
  }
}

/** Picture files from a paste or drop (other content is left to the default handling). */
export const pictureFiles = (data: DataTransfer | null): File[] =>
  [...(data?.files ?? [])].filter(f => f.type.startsWith('image/'));

/**
 * Adds pictures to a page after the block `afterId` (or at the end). Checks the per-page size budget,
 * so the page can still be synced. Returns the new blocks.
 */
export async function addPictures(noteId: string, files: File[], afterId: string | null): Promise<ImageBlock[]> {
  const added: ImageBlock[] = [];
  for (const file of files) {
    let block: ImageBlock;
    try {
      block = await pictureFromFile(file);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error', 6000);
      continue;
    }
    // Re-read the page after the await: it may have been replaced by a sync meanwhile.
    const note = store.getNote(noteId);
    if (!note || note.deleted) break;
    if (pictureBytes(note) + block.src.length > IMAGE_LIMITS.pageSrc) {
      toast(`This page already holds ${mb(pictureBytes(note))} of pictures, the most a page can sync. Add more pictures to a sub-page.`, 'error', 9000);
      break;
    }
    const anchor = added.at(-1)?.id ?? afterId;
    const at = anchor ? note.blocks.findIndex(b => b.id === anchor) : -1;
    note.blocks.splice(at >= 0 ? at + 1 : note.blocks.length, 0, block);
    store.touchNote(note);
    added.push(block);
  }
  return added;
}

/** Opens the system file picker for pictures (resolves with nothing if cancelled). */
export function choosePictureFiles(): Promise<File[]> {
  return new Promise(resolve => {
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/bmp', multiple: true });
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

// ---- Rendering ----

export function renderImage(note: Note, block: ImageBlock, body: HTMLElement): void {
  const img = el('img', { className: 'image-view', src: block.src, alt: block.caption || 'Picture', decoding: 'async', draggable: false });
  if (block.width && block.height) { img.width = block.width; img.height = block.height; }
  img.title = 'Click to view full size';
  img.onclick = () => openLightbox(block);
  const caption = el('input', { className: 'image-caption', type: 'text', value: block.caption, placeholder: 'Add a caption…', maxLength: 500 });
  caption.setAttribute('aria-label', 'Picture caption');
  caption.addEventListener('input', () => { block.caption = caption.value; img.alt = caption.value || 'Picture'; store.touchNote(note); });
  body.append(el('figure', { className: 'image-figure' }, img, caption));
}

let lightbox: HTMLElement | null = null;

function openLightbox(block: ImageBlock): void {
  closeLightbox();
  const img = el('img', { className: 'lightbox-img', src: block.src, alt: block.caption || 'Picture' });
  const box = el('div', { className: 'lightbox', tabIndex: -1 }, img,
    ...(block.caption ? [el('div', { className: 'lightbox-caption', text: block.caption })] : []));
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', block.caption || 'Picture');
  box.onclick = closeLightbox;
  box.onkeydown = e => { if (e.key === 'Escape') closeLightbox(); };
  document.body.append(box);
  lightbox = box;
  box.focus();
}

/** Removes the full-size view (it shows decrypted content, so it is closed when locking). */
export function closeLightbox(): void {
  lightbox?.remove();
  lightbox = null;
}

export const isImageBlock = (b: Block): b is ImageBlock => b.type === 'image';
