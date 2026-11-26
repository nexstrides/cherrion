// Shared HTTP plumbing for the api/ routes (Web-standard Request/Response handlers on Vercel).
import { createMemoryRepo, HttpError, type Repo } from './core.js';
import { createPgRepo } from './pg.js';

let repo: Repo | null = null;

/** Postgres when DATABASE_URL (or POSTGRES_URL) is set; otherwise an in-memory store for local development. */
export function getRepo(): Repo {
  if (repo) return repo;
  const url = process.env.CHERRION_DATABASE_POSTGRES_URL ?? process.env.POSTGRES_URL;
  if (url) {
    repo = createPgRepo(url);
  } else if (process.env.VERCEL) {
    throw new HttpError(500, 'No database is connected. Add a Postgres database to this Vercel project.');
  } else {
    console.warn('[cherrion] DATABASE_URL is not set: using an in-memory database (data is lost on restart).');
    repo = createMemoryRepo();
  }
  return repo;
}

/** Keys the fake-salt HMAC for unknown usernames. */
export const serverSecret = (): string =>
  process.env.CHERRION_SECRET ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? 'cherrion-local-dev';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export async function handle(request: Request, fn: (body: unknown) => Promise<unknown>): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: 'The request body must be JSON.' }, 400); }
  try {
    return json(await fn(body));
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: 'Server error. Please try again.' }, 500);
  }
}
