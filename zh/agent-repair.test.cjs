"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { rejectReason, failingTests } = require("./agent-repair.cjs");

const MARK = "t3code-zh-overlay";

test("the agent may change zh/ and only marked lines of upstream files, never the checks that judge it", () => {
  const ok = [
    [["zh/translation-transform.cjs", "zh/apply.cjs", "zh/web/translation.tsx"], ""],
    [["apps/server/vite.config.ts"], `--- a/x\n+++ b/x\n@@ -3 +3 @@\n-  zh(), // ${MARK}\n+  zh({ server: true }), // ${MARK}\n`],
  ];
  for (const [files, diff] of ok) assert.equal(rejectReason(files, diff), null, files.join());

  const rejected = [
    [["zh/translation.test.cjs"], "", /must not be changed/],
    [["zh/agent-repair.cjs"], "", /must not be changed/],
    [["zh/telemetry-surface.cjs"], "", /must not be changed/],
    [["zh/telemetry-audit.cjs"], "", /must not be changed/],
    [["zh/TELEMETRY_AUDITED"], "", /must not be changed/],
    [["zh/UPSTREAM"], "", /must not be changed/],
    [["zh/package-lock.json"], "", /must not be changed/],
    [[".github/workflows/zh-release.yml"], "", /outside zh\/ and apps\//],
    [["packages/shared/src/x.ts"], "", /outside zh\/ and apps\//],
    [["apps/server/src/bin.ts"], "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n", /without the .* marker/],
    [["apps/server/src/bin.ts"], `@@ -1,0 +2 @@\n+import zh from "zh"; // ${MARK}\n+zh();\n`, /without the .* marker/],
  ];
  for (const [files, diff, reason] of rejected) assert.match(rejectReason(files, diff) ?? "", reason, files.join());
});

test("only top-level failing tests are reported", () => {
  const tap = [
    "TAP version 13",
    "# Subtest: passes",
    "ok 1 - passes",
    "# Subtest: every upstream target transforms",
    "    not ok 1 - nested assertion",
    "not ok 2 - every upstream target transforms",
    "  ---",
    "  duration_ms: 3",
    "ok 3 - skipped one # SKIP",
    "1..3",
  ].join("\n");
  assert.deepEqual(failingTests(tap), ["every upstream target transforms"]);
});
