// POST /api/account
import { authenticate, updateAccount } from './_lib/core.js';
import { getRepo, handle } from './_lib/http.js';

export const POST = (request: Request) => handle(request, async body => updateAccount(getRepo(), await authenticate(getRepo(), request.headers.get('authorization')), body));
