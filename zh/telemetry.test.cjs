"use strict";

// The release gate for telemetry: zh/agent-repair.cjs refuses to publish while any test here fails.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const telemetry = require("./telemetry-transform.cjs");
const surface = require("./telemetry-surface.cjs");

const ROOT = process.env.T3CODE_ZH_ROOT || path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const transformed = (rel) => telemetry.transformTelemetryWithMap(read(rel), path.join(ROOT, rel)).code;

test("telemetry: every hook still fits upstream", () => {
  assert.deepEqual(telemetry.missingTelemetryHooks(ROOT), []);
});

test("telemetry: server analytics is off and has no host", () => {
  const code = transformed("apps/server/src/telemetry/AnalyticsService.ts");
  assert.match(code, /enabled: Config\.Boolean\("T3CODE_ZH_TELEMETRY_OFF"\)\.pipe\(Config\.withDefault\(false\), Config\.map\(\(\) => false\)\)/);
  assert.doesNotMatch(code, /ingest\.t3\.codes/);
  assert.match(code, /posthogHost: Config\.succeed\(""\),/);
  assert.doesNotMatch(code, /T3CODE_POSTHOG_HOST/);
});

test("telemetry: provider logins are never read", () => {
  const code = transformed("apps/server/src/telemetry/Identify.ts");
  assert.match(
    code,
    /readProviderLogins"\)\(function\* \(\s*homeDirectory: string,?\s*\) \{\r?\n  return \{ codexTokens: Option\.none\(\), claudeJson: Option\.none\(\) \};/,
  );
});

test("telemetry: relay tracing has no exporter in any client", () => {
  const code = transformed("packages/shared/src/relayTracing.ts");
  assert.match(code, /config = null;\r?\n\s*if \(config === null\) \{/);
});

test("telemetry: mobile crash reports are off in JS and native", () => {
  assert.match(transformed("apps/mobile/src/features/observability/observe.ts"), /export const crashReportingAvailable = false;/);
  const appConfig = read("apps/mobile/app.config.ts");
  // The override must be the last word before the export, so nothing upstream sets after it.
  assert.match(
    appConfig,
    /observe: \{ endpointUrl: "https:\/\/observe\.invalid" \} \} \}; \/\/ t3code-zh-overlay\r?\nexport default config;/,
  );
});

test("telemetry: a hook that no longer fits fails the build", () => {
  const rel = "packages/shared/src/relayTracing.ts";
  const broken = read(rel).replace("if (config === null) {", "if (!config) {");
  assert.throws(() => telemetry.transformTelemetryWithMap(broken, path.join(ROOT, rel)), /telemetry hook no longer fits/);
});

test("telemetry: every bundler applies the transforms", (t) => {
  const rel = "packages/shared/src/relayTracing.ts";
  const file = path.join(ROOT, rel);
  const source = read(rel);
  const expected = /config = null;/;
  const { zhServerPlugin, zhLocalePlugin } = require("./vite-plugin.cjs");
  assert.match(zhServerPlugin().transform(source, file).code, expected);
  assert.match(zhLocalePlugin().transform(source, file).code, expected);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zh-telemetry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const upstream = path.join(dir, "upstream-transformer.cjs");
  fs.writeFileSync(upstream, "module.exports = { transform: (params) => params.src };\n");
  const previous = process.env.T3CODE_ZH_UPSTREAM_TRANSFORMER;
  process.env.T3CODE_ZH_UPSTREAM_TRANSFORMER = upstream;
  t.after(() => {
    if (previous === undefined) delete process.env.T3CODE_ZH_UPSTREAM_TRANSFORMER;
    else process.env.T3CODE_ZH_UPSTREAM_TRANSFORMER = previous;
  });
  const metro = require("./metro-transformer.cjs");
  assert.match(metro.transform({ src: source, filename: rel, options: { projectRoot: ROOT } }), expected);
});

test("telemetry: upstream telemetry files match the reviewed baseline", () => {
  const diff = surface.diffSurface(surface.scan(ROOT));
  const unreviewed = Object.entries(diff).flatMap(([kind, files]) => files.map((file) => `${kind}: ${file}`));
  assert.deepEqual(
    unreviewed,
    [],
    "Upstream changed code that can send telemetry. Review each file's upstream diff, keep zh/telemetry-transform.cjs " +
      "switching everything off, then run `node zh/telemetry-surface.cjs --write`.",
  );
});
