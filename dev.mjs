// Local-only preview. Production is served by Vercel, not this server.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import handler from './api/analyze.js';
try {
  const env = await readFile(new URL('.env', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* .env is optional. */ }
const files = {'/':'index.html','/index.html':'index.html','/manifest.json':'manifest.json','/icon.svg':'icon.svg'};
const mime = {html:'text/html; charset=utf-8',json:'application/manifest+json; charset=utf-8',svg:'image/svg+xml'};
http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/api/analyze') {
    res.status = n => { res.statusCode=n; return res; };
    res.json = data => res.end(JSON.stringify(data));
    return handler(req,res);
  }
  if (!files[path]) { res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); return res.end('پیدا نشد'); }
  try {const body=await readFile(new URL(files[path],import.meta.url));res.writeHead(200,{'Content-Type':mime[files[path].split('.').pop()],'Cache-Control':'no-cache'});res.end(body);}
  catch {res.writeHead(500);res.end('خطای خواندن فایل');}
}).listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log('Shorts Radar is ready on port '+(process.env.PORT||3000)));
