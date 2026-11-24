#!/usr/bin/env node
/**
 * Downloads the latest official OpenRocket release JAR into public/OpenRocket.jar.
 *
 * Nothing large lives in this repository: the JAR is pulled straight from
 * github.com/openrocket/openrocket/releases at build time (locally or in CI).
 *
 * Usage
 *   node scripts/fetch-openrocket.mjs            # skip work if the pinned build is already present
 *   node scripts/fetch-openrocket.mjs --force    # always re-download
 *
 * Environment
 *   OPENROCKET_VERSION  Pin a release, e.g. "24.12" (also accepts "release-24.12").
 *                       Without it, the latest published (non-prerelease) release is used.
 *   GITHUB_TOKEN        Optional. Uses the GitHub API (higher rate limits) instead of
 *                       the release-page redirect.
 */

import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO = "openrocket/openrocket";
const ROOT = path.resolve(import.meta.dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const JAR_PATH = path.join(PUBLIC_DIR, "OpenRocket.jar");
const MANIFEST_PATH = path.join(PUBLIC_DIR, "openrocket-version.json");

const FORCE = process.argv.includes("--force");
const MAX_ATTEMPTS = 3;
const MIN_PLAUSIBLE_JAR_BYTES = 5_000_000;

const log = (...args) => console.log("[openrocket]", ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function humanBytes(bytes) {
  if (!bytes) return "unknown size";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function fetchWithRetry(url, init = {}, attempt = 1) {
  try {
    return await fetch(url, { ...init, redirect: init.redirect ?? "follow" });
  } catch (error) {
    if (attempt >= MAX_ATTEMPTS) throw error;
    log(`network error (${error.message}); retry ${attempt}/${MAX_ATTEMPTS - 1} in ${attempt}s`);
    await sleep(1000 * attempt);
    return fetchWithRetry(url, init, attempt + 1);
  }
}

/** Find the release to install: pinned version, API, or the /releases/latest redirect. */
async function resolveRelease() {
  const pinned = (process.env.OPENROCKET_VERSION || "").trim();
  if (pinned) {
    const tag = pinned.startsWith("release-") ? pinned : `release-${pinned}`;
    log(`using pinned release ${tag}`);
    return { version: tag.replace(/^release-/, ""), tag };
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    const apiUrl = `https://api.github.com/repos/${REPO}/releases/latest`;
    const res = await fetchWithRetry(apiUrl, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "openrocket-web-build",
      },
    });
    if (res.ok) {
      const release = await res.json();
      const tag = release.tag_name;
      const assets = (release.assets || []).map((asset) => asset.name);
      log(`latest release via API: ${tag}`);
      return { version: tag.replace(/^release-/, ""), tag, assets };
    }
    log(`GitHub API responded ${res.status}; falling back to the release redirect`);
  }

  const res = await fetchWithRetry(`https://github.com/${REPO}/releases/latest`, {
    method: "HEAD",
    redirect: "manual",
  });
  const location = res.headers.get("location") || "";
  const match = location.match(/\/tag\/([^/?#]+)/);
  if (!match) {
    throw new Error(
      `Could not resolve the latest OpenRocket release (HTTP ${res.status}, location: ${location || "none"}). ` +
        "Set OPENROCKET_VERSION to pin one explicitly.",
    );
  }
  const tag = decodeURIComponent(match[1]);
  log(`latest release via redirect: ${tag}`);
  return { version: tag.replace(/^release-/, ""), tag };
}

/** Pick the universal OpenRocket-<version>.jar asset and prove it is downloadable. */
async function resolveAsset(release) {
  const candidates = [];
  if (release.assets) {
    candidates.push(...release.assets.filter((name) => /^OpenRocket-.+\.jar$/i.test(name)));
  }
  candidates.push(`OpenRocket-${release.version}.jar`);

  try {
    const res = await fetchWithRetry(
      `https://github.com/${REPO}/releases/expanded_assets/${encodeURIComponent(release.tag)}`,
    );
    if (res.ok) {
      const html = await res.text();
      for (const name of html.match(/[A-Za-z0-9._+-]+\.jar/g) || []) candidates.push(name);
    }
  } catch (error) {
    log(`could not read the expanded asset list (${error.message}); trying known names`);
  }

  const unique = [...new Set(candidates)].filter(
    (name) => !/installer|sources|javadoc|sha256|sbom/i.test(name),
  );

  for (const name of unique) {
    const url = `https://github.com/${REPO}/releases/download/${release.tag}/${name}`;
    const head = await fetchWithRetry(url, { method: "HEAD" });
    if (head.ok) {
      const size = Number(head.headers.get("content-length") || 0);
      return { name, url, size };
    }
  }

  throw new Error(
    `No JAR asset found for OpenRocket ${release.version}. Tried: ${unique.join(", ") || "(none)"}`,
  );
}

async function download(url, destination, expectedSize) {
  const res = await fetchWithRetry(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);

  const total = Number(res.headers.get("content-length") || expectedSize || 0);
  const hash = createHash("sha256");
  const file = createWriteStream(destination);

  let received = 0;
  let printedAt = 0;

  try {
    for await (const chunk of res.body) {
      const buffer = Buffer.from(chunk);
      hash.update(buffer);
      received += buffer.byteLength;
      if (!file.write(buffer)) {
        await new Promise((resolve) => file.once("drain", resolve));
      }
      const now = Date.now();
      if (now - printedAt > 400) {
        printedAt = now;
        const percent = total ? ` (${((received / total) * 100).toFixed(0)}%)` : "";
        process.stdout.write(`\r[openrocket] downloading ${humanBytes(received)} / ${humanBytes(total)}${percent}   `);
      }
    }
  } finally {
    await new Promise((resolve) => file.end(resolve));
  }

  process.stdout.write(`\r[openrocket] downloaded ${humanBytes(received)}${" ".repeat(24)}\n`);
  return { bytes: received, sha256: hash.digest("hex") };
}

async function readExistingManifest() {
  try {
    return JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  await mkdir(PUBLIC_DIR, { recursive: true });

  const release = await resolveRelease();
  const asset = await resolveAsset(release);

  if (!FORCE) {
    const existing = await readExistingManifest();
    if (existing && existing.version === release.version && existing.asset === asset.name) {
      try {
        const info = await stat(JAR_PATH);
        if (info.size > MIN_PLAUSIBLE_JAR_BYTES && info.size === existing.bytes) {
          log(`public/OpenRocket.jar is already OpenRocket ${release.version} (${humanBytes(info.size)}); nothing to do`);
          return;
        }
      } catch {
        /* missing or unreadable: fall through and download */
      }
    }
  }

  log(`downloading ${asset.name} (${humanBytes(asset.size)})`);
  const { bytes, sha256 } = await download(asset.url, JAR_PATH, asset.size);

  if (bytes < MIN_PLAUSIBLE_JAR_BYTES) {
    throw new Error(`Downloaded file is only ${humanBytes(bytes)}; that is not the OpenRocket application JAR.`);
  }

  const head = Buffer.alloc(4);
  const { open } = await import("node:fs/promises");
  const handle = await open(JAR_PATH, "r");
  try {
    await handle.read(head, 0, 4, 0);
  } finally {
    await handle.close();
  }
  if (head.toString("latin1") !== "PK\u0003\u0004") {
    throw new Error("Downloaded file is not a JAR/ZIP archive (missing PK header).");
  }

  const manifest = {
    version: release.version,
    tag: release.tag,
    asset: asset.name,
    bytes,
    sha256,
    source: asset.url,
    fetchedAt: new Date().toISOString(),
  };
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  log(`ready: OpenRocket ${release.version} -> public/OpenRocket.jar (sha256 ${sha256.slice(0, 16)}…)`);
}

main().catch((error) => {
  console.error(`\n[openrocket] fatal: ${error.message}`);
  process.exitCode = 1;
});
