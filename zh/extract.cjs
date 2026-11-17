// Lists every UI string the localizer can see and the ones the dictionary lacks.
// Usage: node zh/extract.cjs [--out zh/.cache/missing.json] [--stats]
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { ROOT, DICT_PATH, SOURCE_DIRS, isSourceFile, visitModule } = require("./localize.cjs");

function* walkFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else yield full;
  }
}

function collect() {
  const strings = new Map();
  let files = 0;
  let failed = 0;
  for (const dir of SOURCE_DIRS) {
    for (const file of walkFiles(path.join(ROOT, dir))) {
      if (!isSourceFile(file)) continue;
      files += 1;
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      const ok = visitModule(fs.readFileSync(file, "utf8"), file, ({ key, kind, replaceOnly }) => {
        if (replaceOnly) return;
        const entry = strings.get(key) ?? { count: 0, kinds: new Set(), files: new Set() };
        entry.count += 1;
        entry.kinds.add(kind);
        if (entry.files.size < 3) entry.files.add(rel);
        strings.set(key, entry);
      });
      if (ok === false) failed += 1;
    }
  }
  return { strings, files, failed };
}

function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? path.resolve(args[outIndex + 1]) : path.join(__dirname, ".cache", "missing.json");
  const dictionary = fs.existsSync(DICT_PATH) ? JSON.parse(fs.readFileSync(DICT_PATH, "utf8")) : {};
  const { strings, files, failed } = collect();
  const missing = [...strings.entries()]
    .filter(([key]) => !dictionary[key])
    .map(([key, entry]) => ({ key, kinds: [...entry.kinds], files: [...entry.files] }))
    .sort((a, b) => a.key.localeCompare(b.key));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(missing, null, 2) + "\n");
  const translated = strings.size - missing.length;
  console.log(
    `files=${files} unparsable=${failed} strings=${strings.size} translated=${translated} missing=${missing.length} -> ${path.relative(process.cwd(), out)}`,
  );
  if (args.includes("--stats")) {
    const byKind = {};
    for (const entry of strings.values()) for (const kind of entry.kinds) byKind[kind] = (byKind[kind] ?? 0) + 1;
    console.log(byKind);
  }
}

main();
