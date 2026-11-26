/** True in the desktop build (`vite build --mode desktop`), which runs inside the Python/pywebview window. */
export const DESKTOP = import.meta.env.MODE === 'desktop';
