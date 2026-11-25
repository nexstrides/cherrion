import { defineConfig } from 'vitest/config';

// Bind to IPv4 loopback, which every browser reaches. The app redirects 127.0.0.1 to localhost
// (see src/main.ts) because browsers keep separate storage per origin: the vault lives under
// http://localhost:5173, and opening http://127.0.0.1:5173 would otherwise show an empty vault.
export default defineConfig({
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  // libsodium's "sumo" build (needed for Argon2id) is ~550 kB on its own.
  build: { target: 'es2022', chunkSizeWarningLimit: 700 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
