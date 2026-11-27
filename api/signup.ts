// POST /api/signup
import { clientInfo } from './_lib/admin.js';
import { signup } from './_lib/core.js';
import { getRepo, handle } from './_lib/http.js';

export const POST = (request: Request) => handle(request, body => signup(getRepo(), body, clientInfo(request)));
