// POST /api/recover
import { recover } from './_lib/core.js';
import { getRepo, handle } from './_lib/http.js';

export const POST = (request: Request) => handle(request, body => recover(getRepo(), body));
