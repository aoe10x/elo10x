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

async function serveFile(res: http.ServerResponse, filePath: string, defaultMime: string = 'text/plain', extraHeaders: Record<string, string> = {}): Promise<void> {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || defaultMime;
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      ...extraHeaders
    });
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

  // Parse pathname to support query parameters (cache busting)
  const parsedUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Route API requests to data files
  if (pathname === '/api/leaderboard') {
    const leaderboardPath = path.join(DATA_DIR, 'leaderboard.json');
    await serveFile(res, leaderboardPath, 'application/json', {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    return;
  }

  if (pathname === '/api/db') {
    const dbPath = path.join(DATA_DIR, 'db.json');
    await serveFile(res, dbPath, 'application/json', {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    return;
  }

  // Serve static files from public directory
  let targetPath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

  // Prevent Directory Traversal
  const relative = path.relative(PUBLIC_DIR, targetPath);
  const isSafe = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  
  if (pathname !== '/' && !isSafe) {
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
