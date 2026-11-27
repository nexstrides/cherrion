// POST /api/support: recovery requests, reset codes and the owner-recovery (escrow) setting. See _lib/admin.ts.
import { supportAction } from './_lib/admin.js';
import { getRepo, handle } from './_lib/http.js';

export const POST = (request: Request) => handle(request, body => supportAction(getRepo(), request, body));
