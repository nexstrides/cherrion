// POST /api/admin: the owner's dashboard (users, connection history, recovery). See _lib/admin.ts.
import { adminAction } from './_lib/admin.js';
import { getRepo, handle } from './_lib/http.js';

export const POST = (request: Request) => handle(request, body => adminAction(getRepo(), request, body));
