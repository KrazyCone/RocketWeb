#!/usr/bin/env node
/**
 * Tiny development web server for the public/ folder.
 *
 * It answers HTTP Range requests, because CheerpJ reads the application JAR in
 * byte ranges. Firebase Hosting does this natively; this helper reproduces the
 * same behaviour on a developer machine so local testing matches production.
 *
 * Usage: node scripts/serve.mjs [port]   (or PORT=8080 node scripts/serve.mjs)
 */

import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "public");
const PORT = Number(process.env.PORT || process.argv[2] || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".jar": "application/java-archive",
  ".wasm": "application/wasm",
  ".ork": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function contentType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

/** Parse a single "bytes=a-b" range. Returns null when absent or unsatisfiable. */
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  let start = match[1] === "" ? null : Number(match[1]);
  let end = match[2] === "" ? null : Number(match[2]);
  if (start === null && end === null) return null;

  if (start === null) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }

  if (start > end || start >= size) return { unsatisfiable: true };
  return { start, end };
}

async function resolvePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  } catch {
    return null;
  }
  if (decoded.endsWith("/")) decoded += "index.html";

  const target = path.resolve(ROOT, `.${path.posix.normalize(decoded)}`);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null;

  try {
    const info = await stat(target);
    if (info.isDirectory()) return resolvePath(`${decoded}/`);
    return { file: target, size: info.size, mtime: info.mtime };
  } catch {
    return null;
  }
}

const listener = http.createServer(async (req, res) => {
  const resolved = await resolvePath(req.url || "/");

  if (!resolved) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404 Not found\n");
    console.log(`404 ${req.method} ${req.url}`);
    return;
  }

  const range = parseRange(req.headers.range, resolved.size);
  if (range?.unsatisfiable) {
    res.writeHead(416, { "content-range": `bytes */${resolved.size}` });
    res.end();
    return;
  }

  const headers = {
    "content-type": contentType(resolved.file),
    "accept-ranges": "bytes",
    "cache-control": "no-cache",
    "last-modified": resolved.mtime.toUTCString(),
  };

  if (req.method === "HEAD") {
    res.writeHead(200, { ...headers, "content-length": String(resolved.size) });
    res.end();
    return;
  }

  if (range) {
    const { start, end } = range;
    res.writeHead(206, {
      ...headers,
      "content-range": `bytes ${start}-${end}/${resolved.size}`,
      "content-length": String(end - start + 1),
    });
    createReadStream(resolved.file, { start, end }).pipe(res);
    console.log(`206 ${req.method} ${req.url} bytes ${start}-${end}/${resolved.size}`);
    return;
  }

  res.writeHead(200, { ...headers, "content-length": String(resolved.size) });
  createReadStream(resolved.file).pipe(res);
  console.log(`200 ${req.method} ${req.url} (${resolved.size} bytes)`);
});

listener.listen(PORT, HOST, () => {
  console.log(`openrocket-web: serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}  (bound to ${HOST}:${PORT}, range requests supported)`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    listener.close(() => process.exit(0));
  });
}
