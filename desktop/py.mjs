// Runs Python for the npm scripts: desktop/.venv if it exists, otherwise python (or python3) on PATH.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const venv = [join(here, '.venv', 'Scripts', 'python.exe'), join(here, '.venv', 'bin', 'python')].find(existsSync);
const candidates = venv ? [venv] : process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];

for (const python of candidates) {
  const result = spawnSync(python, process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, PYTHONPATH: here } });
  if (result.error && result.error.code === 'ENOENT') continue;
  process.exit(result.status ?? 1);
}
console.error('Python 3 was not found. Install it, then run: python -m venv desktop/.venv && desktop/.venv/Scripts/pip install -r desktop/requirements.txt');
process.exit(1);
