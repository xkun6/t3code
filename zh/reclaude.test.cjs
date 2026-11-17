"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseSync } = require("oxc-parser");

const {
  RUNTIME_SPECIFIER,
  TARGET_FILES,
  transformReclaudeServerWithMap,
} = require("./reclaude-transform.cjs");

function findUpstreamCheckout() {
  const candidates = [
    process.env.T3CODE_ZH_ROOT,
    path.resolve(__dirname, ".."),
    path.resolve(__dirname, "../../../.."),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "apps/server/src/provider/ClaudeProvider.ts"))) {
      return dir;
    }
  }
  return null;
}

/** Matches repair.cjs's exact additive-only safety invariant. */
function repairRejectReason(original, next, mark) {
  const before = original.split("\n");
  const after = next.split("\n");
  let index = 0;
  for (const line of after) {
    if (index < before.length && line === before[index]) index += 1;
    else if (!line.includes(mark)) {
      return `line ${index + 1} changed or unmarked: ${line}`;
    }
  }
  if (index < before.length) return `line ${index + 1} removed`;
  if (!next.includes(mark)) return "nothing added";
  return null;
}

test("detectReclaudeKind distinguishes rec/reclaude, recx/recodex, and standard CLIs", async () => {
  const runtime = await import("./reclaude-runtime.mjs");

  assert.equal(runtime.detectReclaudeKind("rec"), "claude");
  assert.equal(runtime.detectReclaudeKind("C:\\Tools\\reclaude\\bin\\rec.exe"), "claude");
  assert.equal(runtime.detectReclaudeKind("/usr/local/bin/reclaude"), "claude");
  assert.equal(runtime.detectReclaudeKind({ binaryPath: "D:/bin/reclaude.exe" }), "claude");

  assert.equal(runtime.detectReclaudeKind("recx"), "codex");
  assert.equal(runtime.detectReclaudeKind("C:\\Tools\\reclaude\\bin\\recx.exe"), "codex");
  assert.equal(runtime.detectReclaudeKind("/usr/local/bin/recodex"), "codex");
  assert.equal(runtime.detectReclaudeKind({ binaryPath: "recodex.cmd" }), "codex");

  assert.equal(runtime.detectReclaudeKind("claude"), null);
  assert.equal(runtime.detectReclaudeKind("C:\\Users\\me\\.local\\bin\\claude.exe"), null);
  assert.equal(runtime.detectReclaudeKind("codex"), null);
  assert.equal(runtime.detectReclaudeKind("/opt/homebrew/bin/codex"), null);
});

test("splitReclaudeLaunchArgs hoists --org before cli while preserving downstream quoting", async () => {
  const runtime = await import("./reclaude-runtime.mjs");

  assert.deepEqual(
    runtime.splitReclaudeLaunchArgs(
      '--append-system-prompt "hello world" --org 1001 --dangerously-skip-permissions',
    ),
    {
      orgId: "1001",
      orgArgs: ["--org", "1001"],
      prefixArgs: ["--org", "1001", "cli"],
      remainingLaunchArgs: '--append-system-prompt "hello world" --dangerously-skip-permissions',
    },
  );

  assert.deepEqual(runtime.splitReclaudeLaunchArgs('cli --org=2002 -c model="gpt-5"'), {
    orgId: "2002",
    orgArgs: ["--org", "2002"],
    prefixArgs: ["--org", "2002", "cli"],
    remainingLaunchArgs: '-c model="gpt-5"',
  });

  assert.deepEqual(
    runtime.rewriteCodexAppServerArgs("recx.exe", "--org 2002 --strict-config", (rest) => [
      "app-server",
      ...(rest ? rest.split(" ") : []),
    ]),
    ["--org", "2002", "cli", "app-server", "--strict-config"],
  );

  assert.deepEqual(
    runtime.rewriteClaudeCliArgs({ binaryPath: "claude", launchArgs: "--org 1001" }, [
      "--version",
    ]),
    ["--version"],
  );
  assert.deepEqual(
    runtime.rewriteClaudeCliArgs({ binaryPath: "rec.exe", launchArgs: "--org 1001" }, [
      "--version",
    ]),
    ["--org", "1001", "cli", "--version"],
  );
});

test("resolveReclaudeHomeDir and checkReclaudeAuth honor current pointer, single-account fallback, and --org", async () => {
  const runtime = await import("./reclaude-runtime.mjs");
  runtime.__clearReclaudeCacheForTest();

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "zh-reclaude-home-"));
  const validSk = "sk-rec-" + "a".repeat(43);

  try {
    // 1. Unauthenticated directory -> no home resolved, auth fails fast without spawning interactive CLI.
    assert.equal(
      runtime.resolveReclaudeHomeDir("claude", { binaryPath: "rec.exe", launchArgs: "" }, tempHome),
      undefined,
    );

    // 2. Single account without `current` pointer -> selected via single-binding fallback.
    const claudeAcct1 = path.join(tempHome, ".rec/claude/accounts/11");
    fs.mkdirSync(path.join(claudeAcct1, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(claudeAcct1, "device.json"),
      JSON.stringify({
        platform: "claude",
        device_id: 11,
        org_id: 501,
        org_name: "Alpha",
        sk: validSk,
      }),
    );

    assert.equal(
      runtime.resolveReclaudeHomeDir("claude", { binaryPath: "rec.exe", launchArgs: "" }, tempHome),
      path.join(claudeAcct1, "config"),
    );

    // 3. Multiple accounts with `current` pointer + `--org` override.
    const claudeAcct2 = path.join(tempHome, ".rec/claude/accounts/22");
    fs.mkdirSync(path.join(claudeAcct2, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(claudeAcct2, "device.json"),
      JSON.stringify({
        platform: "claude",
        device_id: 22,
        org_id: 502,
        org_name: "Beta",
        sk: validSk,
      }),
    );
    fs.writeFileSync(path.join(tempHome, ".rec/claude/current"), "22");

    assert.equal(
      runtime.resolveReclaudeHomeDir("claude", { binaryPath: "rec.exe", launchArgs: "" }, tempHome),
      path.join(claudeAcct2, "config"),
    );
    assert.equal(
      runtime.resolveReclaudeHomeDir(
        "claude",
        { binaryPath: "rec.exe", launchArgs: "--org 501" },
        tempHome,
      ),
      path.join(claudeAcct1, "config"),
    );

    // 4. Codex binding resolves `<accountDir>/home`.
    const codexAcct = path.join(tempHome, ".rec/codex/accounts/77");
    fs.mkdirSync(path.join(codexAcct, "home"), { recursive: true });
    fs.writeFileSync(path.join(tempHome, ".rec/codex/current"), "77");
    fs.writeFileSync(
      path.join(codexAcct, "device.json"),
      JSON.stringify({
        platform: "codex",
        device_id: 77,
        org_id: 901,
        org_name: "CodexTeam",
        sk: validSk,
      }),
    );

    assert.equal(
      runtime.resolveReclaudeHomeDir("codex", { binaryPath: "recx.exe", launchArgs: "" }, tempHome),
      path.join(codexAcct, "home"),
    );

    const authOk = await runtime.checkReclaudeAuth("codex", {
      binaryPath: "recx.exe",
      launchArgs: "--org 901",
      homeDir: tempHome,
      env: { ...process.env, USERPROFILE: tempHome, HOME: tempHome },
    });
    assert.equal(authOk.ok, true);
    assert.equal(authOk.homeDir, path.join(codexAcct, "home"));

    const authBadOrg = await runtime.checkReclaudeAuth("codex", {
      binaryPath: "C:\\__missing_reclaude_dir__\\recx.exe",
      launchArgs: "--org 9999",
      homeDir: tempHome,
      env: { ...process.env, USERPROFILE: tempHome, HOME: tempHome },
    });
    assert.equal(authBadOrg.ok, false);
    assert.equal(authBadOrg.binaryMissing, true);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test("every upstream server target transforms cleanly with zero missing anchors and valid TS AST", (t) => {
  const upstreamRoot = findUpstreamCheckout();
  if (!upstreamRoot) {
    t.skip("No upstream T3 Code checkout beside zh/");
    return;
  }

  assert.equal(TARGET_FILES.length, 10);
  for (const relFile of TARGET_FILES) {
    const absFile = path.join(upstreamRoot, relFile);
    const source = fs.readFileSync(absFile, "utf8");
    const result = transformReclaudeServerWithMap(source, absFile, {
      root: upstreamRoot,
      bundle: true,
      silent: true,
    });
    assert.ok(result, `expected transform output for ${relFile}`);
    assert.deepEqual(result.warnings, [], `unexpected missing hooks in ${relFile}`);
    assert.ok(
      result.code.includes(`from "${RUNTIME_SPECIFIER}"`),
      `missing runtime import in ${relFile}`,
    );

    const reparsed = parseSync(absFile, result.code, {
      lang: absFile.endsWith(".tsx") ? "tsx" : "ts",
      sourceType: "module",
    });
    assert.deepEqual(
      reparsed.errors,
      [],
      `transformed ${relFile} had syntax errors: ${reparsed.errors.map((e) => e.message).join("; ")}`,
    );
  }
});

test("apply.cjs is idempotent on all config targets and satisfies repair.cjs additive-only invariant", (t) => {
  const upstreamRoot = findUpstreamCheckout();
  if (!upstreamRoot) {
    t.skip("No upstream T3 Code checkout beside zh/");
    return;
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "zh-apply-test-"));
  const patchedFiles = [
    "apps/web/vite.config.ts",
    "apps/desktop/vite.config.ts",
    "apps/server/vite.config.ts",
    "apps/server/src/bin.ts",
    "apps/mobile/metro.config.js",
    "apps/mobile/modules/t3-native-controls/android/src/main/java/expo/modules/t3nativecontrols/T3WorkspaceNavigationModule.kt",
  ];

  try {
    const originals = new Map();
    for (const rel of patchedFiles) {
      const srcPath = path.join(upstreamRoot, rel);
      const dstPath = path.join(sandbox, rel);
      fs.mkdirSync(path.dirname(dstPath), { recursive: true });
      const content = fs.readFileSync(srcPath, "utf8");
      originals.set(rel, content);
      fs.writeFileSync(dstPath, content);
    }

    const applyScript = path.join(__dirname, "apply.cjs");
    execFileSync(process.execPath, [applyScript], {
      env: { ...process.env, T3CODE_ZH_ROOT: sandbox },
      stdio: "pipe",
    });

    const afterFirst = new Map();
    for (const rel of patchedFiles) {
      const next = fs.readFileSync(path.join(sandbox, rel), "utf8");
      afterFirst.set(rel, next);
      assert.ok(next.includes("t3code-zh-overlay"), `${rel} missing overlay marker`);
      if (rel !== patchedFiles[5]) {
        assert.equal(
          repairRejectReason(originals.get(rel), next, "t3code-zh-overlay"),
          null,
          `${rel} violated repair.cjs additive-only rule`,
        );
      }
    }

    // Bundling bin.ts strips the dev-only server-dev-hook line so packaged builds stay self-contained.
    const strippedBin = transformReclaudeServerWithMap(
      afterFirst.get("apps/server/src/bin.ts"),
      path.join(sandbox, "apps/server/src/bin.ts"),
      { root: sandbox, bundle: true, silent: true },
    );
    assert.ok(strippedBin, "expected bin.ts dev-hook strip in bundle mode");
    assert.equal(strippedBin.code.includes("server-dev-hook.cjs"), false);

    // Second apply.cjs run is a strict no-op.
    execFileSync(process.execPath, [applyScript], {
      env: { ...process.env, T3CODE_ZH_ROOT: sandbox },
      stdio: "pipe",
    });
    for (const rel of patchedFiles) {
      assert.equal(fs.readFileSync(path.join(sandbox, rel), "utf8"), afterFirst.get(rel));
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("live rec.exe / recx.exe offline status preflight works when binaries are present", async (t) => {
  const upstreamRoot = findUpstreamCheckout();
  const binDir = upstreamRoot ? path.join(upstreamRoot, "tmp/reclaude/bin") : null;
  const recExe = binDir ? path.join(binDir, "rec.exe") : null;
  const recxExe = binDir ? path.join(binDir, "recx.exe") : null;
  if (!recExe || !fs.existsSync(recExe) || !fs.existsSync(recxExe)) {
    t.skip("tmp/reclaude/bin/rec.exe not present in this checkout");
    return;
  }

  const runtime = await import("./reclaude-runtime.mjs");
  runtime.__clearReclaudeCacheForTest();
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "zh-rec-live-empty-"));

  try {
    const env = { ...process.env, USERPROFILE: emptyHome, HOME: emptyHome };
    const recRes = await runtime.checkReclaudeAuth("claude", {
      binaryPath: recExe,
      env,
      homeDir: emptyHome,
    });
    assert.equal(recRes.ok, false);
    assert.equal(recRes.binaryMissing, false);
    assert.match(recRes.message, /rec login/);

    const recxRes = await runtime.checkReclaudeAuth("codex", {
      binaryPath: recxExe,
      env,
      homeDir: emptyHome,
    });
    assert.equal(recxRes.ok, false);
    assert.equal(recxRes.binaryMissing, false);
    assert.match(recxRes.message, /recx login/);
  } finally {
    fs.rmSync(emptyHome, { recursive: true, force: true });
  }
});
