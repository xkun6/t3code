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
  // A constant: no env value can turn it back on or fail config parsing.
  assert.match(code, /enabled: Config\.succeed\(false\),\n  zhTelemetryOff: Config\.succeed\("T3CODE_ZH_TELEMETRY_OFF:analytics"\),/);
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
  assert.match(code, /config = null;\r?\n\s*Reflect\.set\(globalThis, "T3CODE_ZH_TELEMETRY_OFF:relay", true\);\r?\n\s*if \(config === null\) \{/);
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

test("telemetry: a tracked file stays in the surface after upstream renames what PATTERNS look for", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zh-surface-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rel = "apps/server/src/beacon.ts";
  fs.mkdirSync(path.join(dir, "apps/server/src"), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), 'post("https://example.invalid", usage);\n');
  assert.deepEqual(Object.keys(surface.scan(dir, [])), []);
  assert.deepEqual(Object.keys(surface.scan(dir, [rel])), [rel]);
  // The repair agent may not untrack a file that still exists; a deleted one may go.
  assert.deepEqual(surface.droppedFiles({ [rel]: "x", "apps/gone.ts": "y" }, {}, dir), [rel]);
});

test("telemetry audit: candidates are added shipped lines that use network or home-directory primitives", () => {
  const audit = require("./telemetry-audit.cjs");
  const diff = [
    "+++ b/apps/server/src/report.ts",
    '+const r = await fetch("https://collect.vendor.io/v1", { body });',
    "+const unrelated = 1;",
    "-const removed = fetch(old);",
    "+++ b/apps/server/src/report.test.ts",
    "+fetch(mock);",
    "+++ b/apps/mobile/modules/x/android/Sender.kt",
    "+val client = OkHttpClient()",
    "+++ b/apps/web/src/local.ts",
    '+const dev = "http://localhost:3000";',
    "+++ /dev/null",
    "+fetch(deleted);",
  ].join("\n");
  assert.deepEqual(Object.fromEntries(audit.candidates(diff)), {
    "apps/server/src/report.ts": ['const r = await fetch("https://collect.vendor.io/v1", { body });'],
    "apps/mobile/modules/x/android/Sender.kt": ["val client = OkHttpClient()"],
  });
});

test("telemetry audit: only a complete, well-formed verdict counts, and only default-on or unclear sends block", () => {
  const audit = require("./telemetry-audit.cjs");
  const reply = (findings) => `Reviewed.\n\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\``;
  const finding = (file, status) => ({ file, status, what: "w", destination: "d", reason: "r" });

  assert.match(audit.parseVerdict("no json here", []), /no ```json block/);
  assert.match(audit.parseVerdict("```json\n{nope\n```", []), /does not parse/);
  assert.match(audit.parseVerdict(reply([finding("a.ts", "maybe")]), ["a.ts"]), /unknown status/);
  assert.match(audit.parseVerdict(reply([finding("a.ts", "functional")]), ["a.ts", "b.ts"]), /no finding: b\.ts/);

  const findings = audit.parseVerdict(
    reply([
      finding("a.ts", "functional"),
      finding("b.ts", "opt_in"),
      finding("c.ts", "switched_off"),
      finding("d.ts", "sends_by_default"),
      finding("e.ts", "unsure"),
    ]),
    ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
  );
  const { blocking, tracked } = audit.decide(findings);
  assert.deepEqual(blocking.map((f) => f.file), ["d.ts", "e.ts"]);
  assert.deepEqual(tracked, ["b.ts", "c.ts"]);
});
