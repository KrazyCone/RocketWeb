/**
 * OpenRocket Web — browser bootstrap.
 *
 * Runs the unmodified official OpenRocket JAR on CheerpJ (a WebAssembly JVM)
 * and bridges the virtual filesystem to the user's device:
 *
 *   /app/   read-only view of this web server  -> /app/OpenRocket.jar
 *   /str/   JavaScript -> Java hand-off        -> files picked with "Open .ork…"
 *   /files/ persistent, Java-writable storage  -> designs + simulation exports
 *
 * No backend is involved: the JAR is fetched by the browser and executed locally.
 */

const config = {
  javaVersion: 17,
  jarPath: "/app/OpenRocket.jar",
  versionManifest: "openrocket-version.json",
  displayElementId: "display",
  ...(window.ORWEB_CONFIG || {}),
};

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const BOOT_TIMEOUT_MS = 30_000;
/*
 * cheerpjRunJar() resolves only when the main class exits. OpenRocket is a GUI
 * application that keeps running, so that promise never settles: the overlay
 * has to be dismissed on its own schedule instead of waiting for it.
 */
const REVEAL_BUTTON_AFTER_MS = 12_000;
const REVEAL_OVERLAY_AFTER_MS = 45_000;

/* ------------------------------------------------------------------ DOM ---- */

const $ = (id) => document.getElementById(id);

const ui = {
  badge: $("version-badge"),
  openFile: $("open-file"),
  fileInput: $("file-input"),
  saveDevice: $("save-device"),
  tipsToggle: $("tips-toggle"),
  restart: $("restart"),
  collapse: $("collapse"),
  topbar: $("topbar"),
  progress: $("boot-progress"),
  progressFill: $("progress-fill"),
  progressStage: $("progress-stage"),
  progressDetail: $("progress-detail"),
  progressPercent: $("progress-percent"),
  display: $(config.displayElementId),
  bootOverlay: $("boot-overlay"),
  bootMessage: $("boot-message"),
  bootBar: $("boot-bar-fill"),
  bootPercent: $("boot-percent"),
  bootReveal: $("boot-reveal"),
  stage: $("stage"),
  errorPanel: $("error-panel"),
  errorTitle: $("error-title"),
  errorMessage: $("error-message"),
  errorDetail: $("error-detail"),
  errorReload: $("error-reload"),
  errorHelp: $("error-help"),
  tips: $("tips"),
  tipsClose: $("tips-close"),
  saveDialog: $("save-dialog"),
  saveForm: $("save-form"),
  saveName: $("save-name"),
  saveClose: $("save-close"),
  toasts: $("toasts"),
};

const state = {
  startedAt: performance.now(),
  manifest: null,
  booted: false,
  failed: false,
  creepTimer: null,
};

/* -------------------------------------------------------------- helpers ---- */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "unknown size";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setProgress(value, stage, detail) {
  const percent = clamp(Math.round(value), 0, 100);
  ui.progressFill.style.width = `${percent}%`;
  ui.bootBar.style.width = `${percent}%`;
  if (ui.progressPercent) ui.progressPercent.textContent = `${percent}%`;
  if (ui.bootPercent) ui.bootPercent.textContent = `${percent}%`;
  if (stage) {
    ui.progressStage.textContent = stage;
    ui.bootMessage.textContent = stage;
  }
  // null means "leave the detail line alone" (used by the creep animation).
  if (detail !== null) ui.progressDetail.textContent = detail || "";
}

/**
 * Progress that eases towards a ceiling while a long, unmeasurable step runs.
 * The elapsed counter is what tells a visitor the page is still working when
 * the percentage has stopped moving.
 */
function startCreep(from, ceiling, durationMs, detailLabel) {
  stopCreep();
  const started = performance.now();
  let current = from;
  state.creepTimer = setInterval(() => {
    const elapsed = performance.now() - started;
    const target = from + (ceiling - from) * clamp(elapsed / durationMs, 0, 1);
    if (target > current) {
      current += (target - current) * 0.25;
      setProgress(current, null, null);
    }
    // null detail from setProgress keeps the line alone; this keeps it alive.
    if (detailLabel && !state.booted && !state.failed) {
      ui.progressDetail.textContent = `${detailLabel} · ${Math.round(elapsed / 1000)}s`;
    }
  }, 400);
}

function stopCreep() {
  if (state.creepTimer) {
    clearInterval(state.creepTimer);
    state.creepTimer = null;
  }
}

/* ---------------------------------------------------------------- reveal ---- */

/** Idempotent: dismiss the boot overlay and treat the app as running. */
function finishBoot(reason) {
  if (state.booted || state.failed) return;
  state.booted = true;
  stopCreep();

  setProgress(100, "Ready", "");
  ui.progress.classList.add("is-done");
  ui.bootOverlay.classList.add("is-hidden");
  if (ui.bootReveal) ui.bootReveal.hidden = true;

  const manifest = state.manifest;
  ui.badge.textContent = manifest?.version
    ? `OpenRocket ${manifest.version} · Java ${config.javaVersion}`
    : `OpenRocket · Java ${config.javaVersion}`;

  console.info(
    `[openrocket-web] stage revealed (${reason}) after ` +
      `${((performance.now() - state.startedAt) / 1000).toFixed(1)}s`,
  );
}

/**
 * Offer a manual reveal early, then stop hiding the stage behind the overlay.
 * A blank stage is less confusing than a progress bar that never finishes, and
 * the top progress bar keeps reporting while the JVM is still warming up.
 */
function scheduleReveal() {
  setTimeout(() => {
    if (!state.booted && !state.failed && ui.bootReveal) ui.bootReveal.hidden = false;
  }, REVEAL_BUTTON_AFTER_MS);

  setTimeout(() => {
    if (state.booted || state.failed) return;
    finishBoot("timeout");
    toast(
      "",
      "OpenRocket is still starting",
      "The window will appear here as soon as the Java runtime finishes loading.",
      10_000,
    );
  }, REVEAL_OVERLAY_AFTER_MS);
}

function toast(kind, title, message, ttl = 6500) {
  const el = document.createElement("div");
  el.className = `toast${kind ? ` is-${kind}` : ""}`;
  const heading = document.createElement("strong");
  heading.textContent = title;
  const body = document.createElement("span");
  body.textContent = message;
  el.append(heading, body);
  ui.toasts.append(el);
  setTimeout(() => {
    el.style.transition = "opacity 200ms ease";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 220);
  }, ttl);
  return el;
}

function waitForGlobal(name, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    (function check() {
      if (typeof window[name] === "function") return resolve(window[name]);
      if (performance.now() - started > timeoutMs) {
        return reject(
          new Error(
            `window.${name}() never became available. The CheerpJ loader (cjrtnc.leaningtech.com) ` +
              "was blocked or failed to download.",
          ),
        );
      }
      setTimeout(check, 120);
    })();
  });
}

/* ---------------------------------------------------------------- errors ---- */

function explainError(error) {
  const raw = `${error?.name || ""} ${error?.message || String(error)}`;

  if (/UnsupportedClassVersionError|class file (major )?version/i.test(raw)) {
    return {
      title: "OpenRocket needs a newer Java runtime",
      message:
        `This OpenRocket build was compiled for a newer Java version than CheerpJ is currently ` +
        `running (config: javaVersion ${config.javaVersion}). Raise "javaVersion" in ` +
        "public/runtime-config.js and use a CheerpJ build that supports it (4.3 runs Java 8, 11 " +
        "and 17), or pin an OpenRocket release that matches the runtime.",
    };
  }

  if (/404|not found|Failed to fetch|NetworkError|ERR_|Load failed/i.test(raw)) {
    return {
      title: "The OpenRocket JAR could not be loaded",
      message:
        "public/OpenRocket.jar is missing or unreachable. Run `npm run fetch` to download the " +
        "latest official release, then reload. If you are hosting this site, make sure the JAR " +
        "was uploaded and the host answers HTTP Range requests.",
    };
  }

  if (/OutOfMemory|out of memory|Cannot enlarge memory|allocation failed/i.test(raw)) {
    return {
      title: "This browser ran out of memory",
      message:
        "OpenRocket needs a fair amount of memory inside WebAssembly. Close other tabs and " +
        "large apps, then reload. 8 GB of RAM or more is recommended.",
    };
  }

  if (/cheerpj|loader|never became available/i.test(raw)) {
    return {
      title: "The WebAssembly Java runtime did not load",
      message:
        "The CheerpJ runtime from cjrtnc.leaningtech.com could not be fetched. Check your " +
        "network or content blocker, then reload. The runtime is loaded from CheerpJ's own CDN " +
        "and is required — nothing on this page can replace it.",
    };
  }

  if (/WebAssembly/i.test(raw)) {
    return {
      title: "This browser cannot run WebAssembly",
      message: "Use a current version of Chrome, Edge, Firefox or Safari to run OpenRocket.",
    };
  }

  return {
    title: "OpenRocket could not start",
    message:
      "Something went wrong while starting the Java runtime. Reloading often fixes a " +
      "half-downloaded runtime; the technical details are below.",
  };
}

function showError(error) {
  if (state.failed) return;
  state.failed = true;
  stopCreep();

  const { title, message } = explainError(error);
  ui.errorTitle.textContent = title;
  ui.errorMessage.textContent = message;

  const detail = error?.stack || error?.message || String(error);
  ui.errorDetail.textContent = detail;
  ui.errorDetail.hidden = !detail;

  ui.bootOverlay.classList.add("is-hidden");
  ui.errorPanel.hidden = false;
  ui.progress.classList.add("is-done");

  console.error("[openrocket-web]", error);
}

/* ------------------------------------------------------------------ boot ---- */

async function loadManifest() {
  try {
    const res = await fetch(config.versionManifest, { cache: "no-cache" });
    if (!res.ok) return null;
    state.manifest = await res.json();
    if (state.manifest?.version) {
      const size = state.manifest.bytes ? ` · ${formatBytes(state.manifest.bytes)}` : "";
      ui.badge.textContent = `OpenRocket ${state.manifest.version}${size} · Java ${config.javaVersion}`;
      if (!state.booted) {
        ui.bootMessage.textContent =
          `Loading OpenRocket ${state.manifest.version}` +
          (state.manifest.bytes ? ` (${formatBytes(state.manifest.bytes)})` : "") +
          "…";
      }
    }
    return state.manifest;
  } catch {
    return null;
  }
}

async function boot() {
  if (typeof WebAssembly !== "object") {
    throw new Error("WebAssembly is not available in this browser.");
  }

  ui.badge.textContent = `Java ${config.javaVersion} via CheerpJ`;
  setProgress(3, "Loading the WebAssembly Java runtime", "cheerpj 4.3 · cjrtnc.leaningtech.com");

  await waitForGlobal("cheerpjInit", BOOT_TIMEOUT_MS);

  void loadManifest();

  setProgress(8, "Starting the Java runtime", `Java ${config.javaVersion} · WebAssembly`);
  await cheerpjInit({
    version: config.javaVersion,
    status: "none",
    // Real download progress for the JVM class libraries.
    preloadProgress(done, total) {
      const ratio = total ? done / total : 0;
      setProgress(8 + ratio * 50, "Starting the Java runtime", `${done}/${total} runtime packages`);
    },
  });

  setProgress(60, "Creating the application display", "");
  if (!ui.display) {
    throw new Error(`Display container #${config.displayElementId} is missing from index.html.`);
  }
  cheerpjCreateDisplay(-1, -1, ui.display);

  const manifest = state.manifest;
  setProgress(
    66,
    manifest?.version ? `Loading OpenRocket ${manifest.version}` : "Loading OpenRocket",
    manifest?.asset ? `${manifest.asset}${manifest.bytes ? ` · ${formatBytes(manifest.bytes)}` : ""}` : config.jarPath,
  );

  // Neither the JAR download nor the JVM start reports progress, so ease the
  // bar forward and keep an elapsed counter ticking next to it.
  setProgress(70, "Starting OpenRocket", "Downloading OpenRocket.jar and opening the window");
  startCreep(70, 96, 60_000, "Downloading OpenRocket.jar and opening the window");

  // Deliberately not awaited: OpenRocket never exits, so this promise never
  // settles. finishBoot()/scheduleReveal() dismiss the overlay instead.
  cheerpjRunJar(config.jarPath).then(
    () => finishBoot("application exited"),
    (error) => showError(error),
  );

  scheduleReveal();
}

/* ------------------------------------------------------- file transfers ---- */

function sanitizeFileName(name) {
  const cleaned = String(name)
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || "design.ork";
}

async function stageFileForJava(file) {
  if (typeof window.cheerpOSAddStringFile !== "function") {
    throw new Error("The Java runtime is still starting — try again in a moment.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `That file is ${formatBytes(file.size)}; the limit for staging a design is ${formatBytes(MAX_UPLOAD_BYTES)}.`,
    );
  }

  const name = sanitizeFileName(file.name);
  const path = `/str/${name}`;
  window.cheerpOSAddStringFile(path, new Uint8Array(await file.arrayBuffer()));

  toast(
    "success",
    "Design staged",
    `${file.name} → ${path}. In OpenRocket choose File → Open… and enter that path ` +
      "(or use the upload arrow in the window title bar next time).",
    12_000,
  );
}

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function downloadFromVirtualFs(rawName) {
  if (typeof window.cjFileBlob !== "function") {
    throw new Error("The Java runtime is still starting — try again in a moment.");
  }

  const name = String(rawName).trim().replace(/^\/+/, "");
  if (!name) throw new Error("Enter a file name, for example my-rocket.ork.");

  const candidates = name.includes("/")
    ? [`/files/${name}`]
    : [`/files/${name}`, `/files/downloads/${name}`];

  let lastError = null;
  for (const path of candidates) {
    try {
      const blob = await window.cjFileBlob(path);
      triggerDownload(blob, path.split("/").pop() || "openrocket-file");
      toast("success", "Downloaded", `${path} · ${formatBytes(blob.size)}`);
      return path;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `No file found at ${candidates.join(" or ")}. Save the design in OpenRocket first ` +
      `(File → Save As… → /files/downloads/) — ${lastError?.message || "not found"}.`,
  );
}

/* ---------------------------------------------------------------- wiring ---- */

ui.openFile.addEventListener("click", () => ui.fileInput.click());

ui.fileInput.addEventListener("change", async () => {
  const file = ui.fileInput.files?.[0];
  if (!file) return;
  try {
    await stageFileForJava(file);
  } catch (error) {
    toast("error", "Could not stage that file", error.message, 9000);
    console.error(error);
  } finally {
    ui.fileInput.value = "";
  }
});

ui.saveDevice.addEventListener("click", () => {
  if (!ui.saveDialog.open) ui.saveDialog.showModal();
  ui.saveName.focus();
});

ui.saveForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = $("save-submit");
  submit.disabled = true;
  try {
    await downloadFromVirtualFs(ui.saveName.value);
    ui.saveDialog.close();
  } catch (error) {
    toast("error", "Download failed", error.message, 10_000);
  } finally {
    submit.disabled = false;
  }
});

ui.saveClose.addEventListener("click", () => ui.saveDialog.close());

ui.tipsToggle.addEventListener("click", () => {
  ui.tips.showModal();
  ui.tipsToggle.setAttribute("aria-expanded", "true");
});

ui.tipsClose.addEventListener("click", () => ui.tips.close());

for (const dialog of [ui.tips, ui.saveDialog]) {
  dialog.addEventListener("click", (event) => {
    // Click on the backdrop (the dialog element itself) closes it.
    if (event.target === dialog) dialog.close();
  });
}

ui.tips.addEventListener("close", () => ui.tipsToggle.setAttribute("aria-expanded", "false"));

ui.restart.addEventListener("click", () => {
  ui.restart.disabled = true;
  ui.restart.textContent = "Restarting…";
  location.reload();
});

ui.collapse.addEventListener("click", () => {
  const collapsed = ui.topbar.classList.toggle("is-collapsed");
  ui.collapse.setAttribute("aria-expanded", String(!collapsed));
  ui.collapse.title = collapsed ? "Expand toolbar" : "Collapse toolbar";
});

ui.bootReveal.addEventListener("click", () => finishBoot("manual"));

ui.errorReload.addEventListener("click", () => location.reload());
ui.errorHelp.addEventListener("click", () => {
  ui.errorPanel.hidden = true;
  ui.tips.showModal();
});

window.addEventListener("error", (event) => {
  if (!state.booted) showError(event.error || new Error(event.message));
});

window.addEventListener("unhandledrejection", (event) => {
  if (!state.booted) showError(event.reason);
});

// Useful when debugging from the console.
window.openrocketWeb = {
  config,
  state,
  downloadFromVirtualFs,
  stageFileForJava,
  reload: () => location.reload(),
};

boot().catch((error) => showError(error));
