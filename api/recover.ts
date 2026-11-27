// POST /api/recover
import { clientInfo } from './_lib/admin.js';
import { recover } from './_lib/core.js';
import { getRepo, handle } from './_lib/http.js';

export const POST = (request: Request) => handle(request, body => recover(getRepo(), body, clientInfo(request)));
