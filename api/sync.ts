// POST /api/sync
import { clientInfo } from './_lib/admin.js';
import { authenticate, sync } from './_lib/core.js';
import { getRepo, handle } from './_lib/http.js';

export const POST = (request: Request) => handle(request, async body =>
  sync(getRepo(), await authenticate(getRepo(), request.headers.get('authorization')), body, clientInfo(request)));
