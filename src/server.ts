import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const DATA_DIR = path.join(process.cwd(), 'data');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

async function serveFile(res: http.ServerResponse, filePath: string, defaultMime: string = 'text/plain'): Promise<void> {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || defaultMime;
    const content = await fs.readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`500 Internal Server Error: ${error.message}`);
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  console.log(`${req.method} ${url}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Route API requests to data files
  if (url === '/api/leaderboard') {
    const leaderboardPath = path.join(DATA_DIR, 'leaderboard.json');
    await serveFile(res, leaderboardPath, 'application/json');
    return;
  }

  if (url === '/api/db') {
    const dbPath = path.join(DATA_DIR, 'db.json');
    await serveFile(res, dbPath, 'application/json');
    return;
  }

  // Serve static files from public directory
  let targetPath = path.join(PUBLIC_DIR, url === '/' ? 'index.html' : url);

  // Prevent Directory Traversal
  const relative = path.relative(PUBLIC_DIR, targetPath);
  const isSafe = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  
  if (url !== '/' && !isSafe) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  await serveFile(res, targetPath, 'text/html');
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser to view the leaderboard dashboard.`);
});
