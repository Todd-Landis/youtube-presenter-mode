// Serves the move-video spike on http://localhost:8642/ with byte-range
// support (Safari won't play an MP4 over HTTP without it). Generates the test
// media first if it's missing. Run: npm run spike
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8642;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4' };

const media = path.join(DIR, 'media');
if (!fs.existsSync(path.join(media, 'clip.mp4')) || !fs.existsSync(path.join(media, 'clip-frag.mp4'))) {
  console.log('Generating test media (about 15 s)…');
  const r = spawnSync('swift', [path.join(DIR, '../../scripts/make-spike-media.swift'), media], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.join(DIR, rel);
  if (!file.startsWith(DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  const size = fs.statSync(file).size;
  const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') return void res.end();
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`Move-video spike: http://localhost:${PORT}/  (open it in Safari; Ctrl+C to stop)`);
});
