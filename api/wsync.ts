import { authenticate } from './_lib/core.js';
import { getRepo, handle } from './_lib/http.js';
import { workspaceSync } from './_lib/workspaces.js';

export const POST = (request: Request) =>
  handle(request, async body => {
    const repo = getRepo();
    return workspaceSync(repo, await authenticate(repo, request.headers.get('authorization')), body);
  });
