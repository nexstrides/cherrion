// Document Picture-in-Picture (Chrome/Edge) is not in TypeScript's DOM library yet.
interface DocumentPictureInPictureOptions { width?: number; height?: number }
interface DocumentPictureInPicture extends EventTarget {
  requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>;
  readonly window: Window | null;
}
interface Window { readonly documentPictureInPicture?: DocumentPictureInPicture }
