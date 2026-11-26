import { existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Serves the api/ routes during `npm run dev`, the same handlers Vercel runs in production.
 * They use Postgres when DATABASE_URL is set (e.g. in .env.local) and an in-memory database otherwise.
 */
function cherrionApi(): Plugin {
  return {
    name: 'cherrion-api',
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res, next) => {
        const match = /^\/api\/([a-z-]+)(?:\?.*)?$/.exec(req.url ?? '');
        if (!match || !existsSync(`api/${match[1]}.ts`)) { next(); return; }
        try {
          const mod = (await server.ssrLoadModule(`/api/${match[1]}.ts`)) as { POST?: (r: Request) => Promise<Response> };
          if (req.method !== 'POST' || !mod.POST) { res.statusCode = 405; res.end(); return; }
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
          const response = await mod.POST(new Request(`http://localhost${req.url}`, { method: 'POST', headers, body: Buffer.concat(chunks) }));
          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (err) {
          server.config.logger.error(`[cherrion-api] ${err instanceof Error ? err.stack : String(err)}`);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Local API error (see the terminal).' }));
        }
      });
    },
  };
}

// Bind to IPv4 loopback, which every browser reaches (Vite's default "localhost" can bind IPv6 only). The app redirects 127.0.0.1 to localhost
// (see src/main.ts) because browser storage is per origin.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'CHERRION_SECRET']) {
    if (env[key] && !process.env[key]) process.env[key] = env[key];
  }
  // `npm run dev:live` sets CHERRION_API_URL (in .env.live) to use the deployed API and database instead.
  const remote = env.CHERRION_API_URL;
  // `--mode desktop` builds the front end for the Python desktop app (desktop/), which talks to its
  // vault file and sync server through the pywebview bridge instead of /api.
  const desktop = mode === 'desktop';
  return {
    plugins: remote || desktop ? [] : [cherrionApi()],
    server: {
      host: '127.0.0.1', port: 5173, strictPort: true,
      ...(remote ? { proxy: { '/api': { target: remote, changeOrigin: true, secure: true } } } : {}),
    },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true },
    // libsodium's "sumo" build (needed for Argon2id) is ~550 kB on its own.
    build: { target: 'es2022', chunkSizeWarningLimit: 700, outDir: desktop ? 'dist-desktop' : 'dist', emptyOutDir: true },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
    },
  };
});
