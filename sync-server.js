const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 3456;
const DATA_DIR = path.join(__dirname, 'sync-data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function safeRoom(name) { return name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'default'; }

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const match = req.url.match(/^\/sync\/([^/?]+)/);
  if (req.method === 'POST' && match) {
    const roomFile = path.join(DATA_DIR, `${safeRoom(decodeURIComponent(match[1]))}.json`);
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        const incoming = JSON.parse(body).notes || {};
        const existing = fs.existsSync(roomFile) ? JSON.parse(fs.readFileSync(roomFile, 'utf8')) : {};
        for (const [id, note] of Object.entries(incoming)) {
          if (!existing[id] || note.updatedAt > existing[id].updatedAt) existing[id] = note;
        }
        fs.writeFileSync(roomFile, JSON.stringify(existing, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ notes: existing }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`Cherrion Sync Server running at http://localhost:${PORT}`));
