#!/usr/bin/env node
/**
 * Pre-flight checks before a deploy. Fails loudly instead of publishing a page
 * that cannot start OpenRocket (for example, when the release asset changed name).
 */

import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const MIN_JAR_BYTES = 5_000_000;

const failures = [];
const notes = [];

async function requireFile(relative, { minBytes = 1 } = {}) {
  const file = path.join(ROOT, relative);
  try {
    const info = await stat(file);
    if (info.size < minBytes) {
      failures.push(`${relative} is only ${info.size} bytes`);
      return null;
    }
    return info;
  } catch {
    failures.push(`${relative} is missing`);
    return null;
  }
}

await requireFile("public/index.html", { minBytes: 500 });
await requireFile("public/styles.css", { minBytes: 500 });
await requireFile("public/app.js", { minBytes: 500 });
await requireFile("public/runtime-config.js", { minBytes: 50 });
await requireFile("firebase.json", { minBytes: 50 });

const jarInfo = await requireFile("public/OpenRocket.jar", { minBytes: MIN_JAR_BYTES });

if (jarInfo) {
  // Read only the header: the JAR is ~80 MB and has no business in memory.
  const handle = await open(path.join(PUBLIC_DIR, "OpenRocket.jar"), "r");
  let magic = "";
  try {
    const header = Buffer.alloc(4);
    await handle.read(header, 0, 4, 0);
    magic = header.toString("latin1");
  } finally {
    await handle.close();
  }
  if (magic !== "PK\u0003\u0004") {
    failures.push("public/OpenRocket.jar does not start with a JAR/ZIP header");
  }
  notes.push(`OpenRocket.jar: ${(jarInfo.size / 1e6).toFixed(1)} MB`);
}

try {
  const manifest = JSON.parse(await readFile(path.join(PUBLIC_DIR, "openrocket-version.json"), "utf8"));
  notes.push(`OpenRocket version: ${manifest.version} (${manifest.asset})`);
  if (!manifest.version) failures.push("openrocket-version.json has no version field");
} catch {
  notes.push("openrocket-version.json missing (the page still runs, the version badge stays empty)");
}

try {
  const firebaseJson = JSON.parse(await readFile(path.join(ROOT, "firebase.json"), "utf8"));
  if (firebaseJson.hosting?.public !== "public") {
    failures.push('firebase.json must set hosting.public to "public"');
  }
} catch (error) {
  failures.push(`firebase.json is not valid JSON: ${error.message}`);
}

for (const note of notes) console.log(`  · ${note}`);

if (failures.length) {
  console.error("\nBuild verification failed:");
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log("Build verification passed.");
