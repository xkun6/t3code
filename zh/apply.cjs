// Wires the zh overlay into an upstream checkout. Idempotent. When an anchor is gone it writes
// zh/.cache/apply-failures.json and exits 2 so the pipeline can run repair.cjs.
// Usage: node zh/apply.cjs
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = process.env.T3CODE_ZH_ROOT || path.resolve(__dirname, "..");
const MARK = "t3code-zh-overlay";
const FAILURES_PATH = path.join(__dirname, ".cache", "apply-failures.json");

// Loaded at runtime rather than imported: Vite inlines relative imports into its config bundle,
// where Tailwind's module hook breaks the overlay's CommonJS require of oxc-parser.
const VITE_IMPORT =
  `import * as zhModule from "node:module"; // ${MARK}\n` +
  `const { zhLocalePlugin } = zhModule.createRequire(import.meta.url)("../../zh/vite-plugin.cjs"); // ${MARK}\n`;

const EDITS = [
  {
    file: "apps/web/vite.config.ts",
    goal:
      'Load `{ zhLocalePlugin }` from "../../zh/vite-plugin.cjs" at runtime with `createRequire(import.meta.url)` from "node:module" (not a static import, which Vite would inline into its config bundle) and add `zhLocalePlugin()` to the Vite `plugins` array of the main config, before the TanStack router and React plugins.',
    steps: [
      {
        anchor: /^import \{ defineConfig[^\n]*\n/m,
        insert: (match) => `${match}${VITE_IMPORT}`,
      },
      {
        anchor: /^(\s*)tanstackRouter\(/m,
        insert: (match, indent) => `${indent}zhLocalePlugin(), // ${MARK}\n${match}`,
      },
    ],
  },
  {
    file: "apps/desktop/vite.config.ts",
    goal:
      'Load `{ zhLocalePlugin }` from "../../zh/vite-plugin.cjs" at runtime with `createRequire(import.meta.url)` from "node:module" (not a static import, which Vite would inline into its config bundle) and add `plugins: [zhLocalePlugin()]` to the `pack` entry that builds "src/main.ts" (the Electron main process).',
    steps: [
      {
        anchor: /^import \{ defaultInclude, defineConfig[^\n]*\n/m,
        insert: (match) => `${match}${VITE_IMPORT}`,
      },
      {
        anchor: /^(\s*)entry: \["src\/main\.ts"\],\n/m,
        insert: (match, indent) => `${match}${indent}plugins: [zhLocalePlugin()], // ${MARK}\n`,
      },
    ],
  },
  {
    file: "apps/mobile/metro.config.js",
    goal:
      'Require `{ withZhLocale }` from "../../zh/metro.cjs" and pass the final Metro config through it: the exported config (or the promise it is exported as) must resolve to `withZhLocale(finalConfig)`.',
    steps: [
      {
        // Wraps whatever was exported (a config or a promise of one), so no anchor is needed.
        anchor: /\s*$/,
        insert: () =>
          `\nconst { withZhLocale } = require("../../zh/metro.cjs"); // ${MARK}\nmodule.exports = Promise.resolve(module.exports).then(withZhLocale); // ${MARK}\n`,
      },
    ],
  },
];

function main() {
  const failures = [];
  for (const edit of EDITS) {
    const full = path.join(ROOT, edit.file);
    let source = fs.readFileSync(full, "utf8");
    if (source.includes(MARK)) {
      console.log(`already applied: ${edit.file}`);
      continue;
    }
    const missing = edit.steps.filter((step) => !step.anchor.test(source));
    if (missing.length > 0) {
      failures.push({ file: edit.file, goal: edit.goal, mark: MARK });
      console.error(`anchor not found in ${edit.file}: ${missing.map((step) => step.anchor).join(", ")}`);
      continue;
    }
    for (const step of edit.steps) {
      const match = source.match(step.anchor);
      source = source.slice(0, match.index) + step.insert(...match) + source.slice(match.index + match[0].length);
    }
    fs.writeFileSync(full, source);
    console.log(`applied: ${edit.file}`);
  }
  fs.mkdirSync(path.dirname(FAILURES_PATH), { recursive: true });
  fs.writeFileSync(FAILURES_PATH, JSON.stringify(failures, null, 2) + "\n");
  if (failures.length > 0) process.exit(2);
}

main();
