// POST /api/sync
import { authenticate, sync } from './_lib/core.js';
import { getRepo, handle } from './_lib/http.js';

export const POST = (request: Request) => handle(request, async body => sync(getRepo(), await authenticate(getRepo(), request.headers.get('authorization')), body));
