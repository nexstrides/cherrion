// POST /api/login
import { login } from './_lib/core.js';
import { getRepo, handle } from './_lib/http.js';

export const POST = (request: Request) => handle(request, body => login(getRepo(), body));
