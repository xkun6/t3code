// Fingerprints every upstream source file that can send telemetry or read the logins it reports.
// zh/telemetry-surface.json is the reviewed baseline: when an upstream merge adds, changes or removes
// one of these files, zh/telemetry.test.cjs fails until someone reviews the diff, keeps
// zh/telemetry-transform.cjs covering it, and rewrites the baseline with `--write`.
// PATTERNS only find code that still uses known names; zh/telemetry-audit.cjs has an agent find the rest
// and adds those files to the baseline, which keeps them tracked whatever they contain.
// Usage: node zh/telemetry-surface.cjs [--write]
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = process.env.T3CODE_ZH_ROOT || path.resolve(__dirname, "..");
const BASELINE_PATH = path.join(__dirname, "telemetry-surface.json");
const SCAN_DIRS = ["apps/server/src", "apps/web/src", "apps/desktop/src", "apps/mobile/src", "packages"];
const EXTRA_FILES = ["apps/mobile/app.config.ts", ".env.example"];
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP_DIR = new Set(["node_modules", "dist", "build", "__tests__", "test", "tests", ".turbo"]);
const SKIP_FILE = /\.(?:test|spec|browser\.test)\.[cm]?[jt]sx?$/;
const PATTERNS = [
  /posthog/i,
  /ingest\.t3\.codes/,
  /axiom/i,
  /\bOtlp(?:Tracer|Logger|Metrics|Exporter)\b/,
  /expo-observe/,
  /OTLP_TRACES_(?:TOKEN|DATASET)/,
  /T3CODE_TELEMETRY_ENABLED/,
  // Login ids matter only once something sends them; AnalyticsService is the one sender today.
  /accountUuid/,
  /sendBeacon/,
];

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (SOURCE.test(entry.name) && !SKIP_FILE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/**
 * `{ relativePath: sha256 }`, LF-normalized so checkouts agree, for every file matching PATTERNS plus
 * every `tracked` file. Tracked files (the baseline, and what zh/telemetry-audit.cjs adds) stay in the
 * surface after upstream renames the names PATTERNS look for, so a rename shows up as a change.
 */
function scan(root = ROOT, tracked = Object.keys(readBaseline())) {
  const files = SCAN_DIRS.flatMap((dir) => walk(path.join(root, dir), []));
  files.push(...EXTRA_FILES.map((file) => path.join(root, file)));
  const always = new Set(tracked.map((rel) => path.join(root, rel)));
  files.push(...always);
  const surface = {};
  for (const file of new Set(files)) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    if (!always.has(file) && !PATTERNS.some((pattern) => pattern.test(text))) continue;
    // The overlay's own marked lines must not make every apply look like an upstream change.
    const upstream = text.split("\n").filter((line) => !line.includes("t3code-zh-overlay")).join("\n");
    const rel = path.relative(root, file).split(path.sep).join("/");
    surface[rel] = crypto.createHash("sha256").update(upstream).digest("hex").slice(0, 16);
  }
  return Object.fromEntries(Object.entries(surface).sort(([a], [b]) => a.localeCompare(b)));
}

function readBaseline() {
  return fs.existsSync(BASELINE_PATH) ? JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) : {};
}

function writeBaseline(surface) {
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(surface, null, 2)}\n`);
}

/** Tracked files the agent dropped from the surface while they still exist upstream. */
function droppedFiles(before, after, root = ROOT) {
  return Object.keys(before).filter((rel) => !(rel in after) && fs.existsSync(path.join(root, rel)));
}

/** Files added, changed or removed relative to the reviewed baseline. */
function diffSurface(current = scan(), baseline = readBaseline()) {
  const files = [...new Set([...Object.keys(current), ...Object.keys(baseline)])].sort();
  return {
    added: files.filter((file) => !(file in baseline)),
    changed: files.filter((file) => file in baseline && file in current && baseline[file] !== current[file]),
    removed: files.filter((file) => !(file in current)),
  };
}

function main() {
  const current = scan();
  if (process.argv.includes("--write")) {
    writeBaseline(current);
    console.log(`wrote ${Object.keys(current).length} files to ${path.relative(ROOT, BASELINE_PATH)}`);
    return;
  }
  const diff = diffSurface(current);
  for (const [kind, files] of Object.entries(diff)) for (const file of files) console.log(`${kind}: ${file}`);
  if (Object.values(diff).some((files) => files.length > 0)) process.exit(1);
  console.log(`telemetry surface unchanged (${Object.keys(current).length} files)`);
}

if (require.main === module) main();

module.exports = { BASELINE_PATH, scan, diffSurface, readBaseline, writeBaseline, droppedFiles };
