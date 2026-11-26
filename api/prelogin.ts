// POST /api/prelogin
import { prelogin } from './_lib/core.js';
import { getRepo, handle, serverSecret } from './_lib/http.js';

export const POST = (request: Request) => handle(request, body => prelogin(getRepo(), serverSecret(), body));
