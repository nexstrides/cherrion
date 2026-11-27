import { authenticate } from './_lib/core.js';
import { fileAction } from './_lib/files.js';
import { getRepo, handle } from './_lib/http.js';

export const POST = (request: Request) =>
  handle(request, async body => {
    const repo = getRepo();
    return fileAction(repo, await authenticate(repo, request.headers.get('authorization')), body);
  });
