// POST /api/account
// - { currentAuthKey, header, … }: password change and recovery-key rotation (core.updateAccount).
// - { action: 'request' | 'reset' | 'escrow', … }: account help (see _lib/admin.ts supportAction).
//   They share this endpoint because Vercel's free plan allows 12 functions per deployment.
import { supportAction } from './_lib/admin.js';
import { authenticate, updateAccount } from './_lib/core.js';
import { getRepo, handle } from './_lib/http.js';

export const POST = (request: Request) => handle(request, async body => {
  if (typeof body === 'object' && body !== null && typeof (body as { action?: unknown }).action === 'string') {
    return supportAction(getRepo(), request, body);
  }
  return updateAccount(getRepo(), await authenticate(getRepo(), request.headers.get('authorization')), body);
});
