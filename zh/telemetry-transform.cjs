// Build-time transforms that switch off everything upstream sends home: product analytics
// (ingest.t3.codes / PostHog), the provider-login reads that identify you to it, relay traces
// (Axiom) in every client, and the mobile app's crash reports.
// Unlike the other overlays this never degrades: a target whose anchor is gone throws, so the build
// fails rather than shipping with telemetry on. zh/telemetry.test.cjs checks every hook.
"use strict";

const path = require("node:path");
const MagicString = require("magic-string").default;

// Survives minification, so the workflow can grep the server bundle for it.
const MARKER = "T3CODE_ZH_TELEMETRY_OFF";

/** Relative path → hooks. Each hook's anchor must match exactly once. */
const HOOKS = {
  "apps/server/src/telemetry/AnalyticsService.ts": [
    {
      name: "enabled",
      anchor: /enabled: Config\.Boolean\("T3CODE_TELEMETRY_ENABLED"\)\.pipe\(Config\.withDefault\(true\)\),/g,
      replace: () => `enabled: Config.Boolean("${MARKER}").pipe(Config.withDefault(false), Config.map(() => false)),`,
    },
    {
      // Second line of defence: no host, and no env var can set one.
      name: "host",
      anchor: /Config\.String\("T3CODE_POSTHOG_HOST"\)\.pipe\(\s*Config\.withDefault\("https:\/\/ingest\.t3\.codes"\),?\s*\)/g,
      replace: () => `Config.succeed("")`,
    },
  ],
  "apps/server/src/telemetry/Identify.ts": [
    {
      name: "readProviderLogins",
      anchor:
        /(const readProviderLogins = Effect\.fn\("TelemetryIdentity\.readProviderLogins"\)\(function\* \(\s*homeDirectory: string,?\s*\) \{\r?\n)/g,
      replace: (match) => `${match}  return { codexTokens: Option.none(), claudeJson: Option.none() };\n`,
    },
  ],
  "packages/shared/src/relayTracing.ts": [
    {
      name: "layer",
      anchor: /^(\s*)if \(config === null\) \{\r?\n\s*return Layer\.succeed\(RelayClientTracer, Option\.none\(\)\);/gm,
      replace: (match, indent) => `${indent}config = null;\n${match}`,
    },
  ],
  "apps/mobile/src/features/observability/observe.ts": [
    {
      name: "crashReportingAvailable",
      anchor: /export const crashReportingAvailable = [^;]+;/g,
      replace: () => "export const crashReportingAvailable = false;",
    },
  ],
};

const TARGET_FILES = Object.keys(HOOKS);

function relativePath(file, root) {
  const normalized = String(file ?? "").split("?")[0].split("\\").join("/");
  const base = (root || process.env.T3CODE_ZH_ROOT || path.resolve(__dirname, "..")).split("\\").join("/");
  if (normalized.startsWith(`${base}/`)) return normalized.slice(base.length + 1);
  // Builds run from an isolated copy can see the same sources under another root.
  return TARGET_FILES.find((target) => normalized.endsWith(`/${target}`)) ?? normalized;
}

/** `rel#hook` for every hook whose anchor does not match exactly once. */
function missingHooks(code, rel) {
  return HOOKS[rel]
    .filter((hook) => (code.match(hook.anchor) ?? []).length !== 1)
    .map((hook) => `${rel}#${hook.name}`);
}

/** `{ code, map }` for a telemetry target, null for any other file. Throws when a hook no longer fits. */
function transformTelemetryWithMap(code, file, options = {}) {
  const rel = relativePath(file, options.root);
  if (!HOOKS[rel]) return null;
  const missing = missingHooks(code, rel);
  if (missing.length > 0) {
    throw new Error(`t3code-zh: telemetry hook no longer fits upstream (${missing.join(", ")}); refusing to build with telemetry on.`);
  }
  const ms = new MagicString(code);
  for (const hook of HOOKS[rel]) {
    hook.anchor.lastIndex = 0;
    const match = hook.anchor.exec(code);
    ms.overwrite(match.index, match.index + match[0].length, hook.replace(...match));
  }
  return { code: ms.toString(), map: ms.generateMap({ hires: "boundary", source: file }) };
}

/** `rel#hook` for every target that is missing or no longer fits, read from an upstream checkout. */
function missingTelemetryHooks(root) {
  const fs = require("node:fs");
  return TARGET_FILES.flatMap((rel) => {
    const file = path.join(root, rel);
    return fs.existsSync(file) ? missingHooks(fs.readFileSync(file, "utf8"), rel) : [rel];
  });
}

module.exports = { MARKER, TARGET_FILES, transformTelemetryWithMap, missingTelemetryHooks };
