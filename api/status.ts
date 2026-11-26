// POST /api/status
import { status } from './_lib/core.js';
import { getRepo, handle } from './_lib/http.js';

export const POST = (request: Request) => handle(request, () => status(getRepo()));
