// Runs after an upstream merge broke the overlay (apply.cjs or the overlay tests failed): a coding agent
// (Claude Code CLI on DeepSeek's Anthropic endpoint) fixes zh/ to fit the new upstream code.
// Its work is kept only when apply.cjs and every overlay test pass, it left the gate files alone, and
// outside zh/ it touched nothing but lines marked t3code-zh-overlay; otherwise it is reverted.
// Hooks still missing after that ship degraded: the build skips them and the step names them.
// Exits 1 when apply.cjs still fails, since a build without the config hooks has no overlay at all,
// and when zh/telemetry.test.cjs fails: a release never ships with telemetry on.
// Env: DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_PROTOCOL, DEEPSEEK_MODEL, DEEPSEEK_AGENT_MODEL, CLAUDE_BIN.
// Usage: node zh/agent-repair.cjs <tag> <previous tag> [failure log...]
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const MARK = "t3code-zh-overlay";
const TESTS = "zh/*.test.cjs";
const TELEMETRY_TESTS = "zh/telemetry.test.cjs";
const ATTEMPTS = 2;
const AGENT_TIMEOUT_MS = 25 * 60 * 1000;
const LOG_TAIL_CHARS = 15_000;
// The agent must not edit the checks that judge it, nor files other steps own.
const PROTECTED = [
  /^zh\/[^/]*\.test\.cjs$/,
  /^zh\/agent-repair\.cjs$/,
  // The telemetry gates: what counts as telemetry surface, and the audit that grows it.
  /^zh\/telemetry-(surface|audit)\.cjs$/,
  /^zh\/TELEMETRY_AUDITED$/,
  /^zh\/UPSTREAM$/,
  /^zh\/package(-lock)?\.json$/,
];
const ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  // Edit rules also cover Write; Claude Code rejects Write(path) rules.
  "Edit(zh/**)",
  "Edit(apps/**)",
  "Bash(node zh/apply.cjs)",
  `Bash(node --test ${TESTS})`,
  "Bash(node zh/telemetry-surface.cjs)",
  "Bash(node zh/telemetry-surface.cjs --write)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git status)",
];

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function tail(text, chars = LOG_TAIL_CHARS) {
  return text.length > chars ? `...\n${text.slice(-chars)}` : text;
}

/** Null when the staged change set may be kept, otherwise why not. `appsDiff` is `git diff -U0` of apps/. */
function rejectReason(files, appsDiff) {
  for (const file of files) {
    if (PROTECTED.some((pattern) => pattern.test(file))) return `${file} must not be changed`;
    if (!file.startsWith("zh/") && !file.startsWith("apps/")) return `${file} is outside zh/ and apps/`;
  }
  for (const line of appsDiff.split("\n")) {
    if (/^(\+\+\+|---) /.test(line) || !/^[+-]/.test(line)) continue;
    if (!line.includes(MARK)) return `an upstream line without the ${MARK} marker was changed: ${JSON.stringify(line.slice(0, 160))}`;
  }
  return null;
}

/** Top-level test names reported `not ok` in TAP output. */
function failingTests(tap) {
  return [...tap.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1].trim());
}

/** `file#hook` for every overlay hook that does not apply to the current upstream sources. */
function missingHooks(root = ROOT) {
  const reclaude = require("./reclaude-transform.cjs");
  const translation = require("./translation-transform.cjs");
  const telemetry = require("./telemetry-transform.cjs");
  const groups = [
    [reclaude.TARGET_FILES, reclaude.transformReclaudeServerWithMap],
    [translation.SERVER_TARGET_FILES, translation.transformTranslationServerWithMap],
    [translation.WEB_TARGET_FILES, translation.transformTranslationWebWithMap],
    [translation.MOBILE_TARGET_FILES, translation.transformTranslationMobileWithMap],
  ];
  const missing = [];
  for (const [files, apply] of groups) {
    for (const rel of files) {
      const file = path.join(root, rel);
      if (!fs.existsSync(file)) {
        missing.push(rel);
        continue;
      }
      const result = apply(fs.readFileSync(file, "utf8"), file, { root, silent: true, bundle: true });
      missing.push(...(result ? result.warnings : [rel]));
    }
  }
  missing.push(...telemetry.missingTelemetryHooks(root));
  return missing;
}

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

const runApply = () => run(["zh/apply.cjs"]);
const runTests = () => run(["--test", "--test-reporter=tap", TESTS]);

function agentPrompt({ tag, previous, failures, hooks, feedback }) {
  return `Upstream t3code ${tag} was just merged into this fork; the previous upstream release was ${previous}.
The Chinese overlay no longer fits the new upstream code. Make it fit again, then stop.

Read zh/AGENTS.md first: it explains the overlay and the rules for touching upstream files.

How to work:
- See what upstream changed with \`git diff ${previous} ${tag} -- <file>\` for the files named below.
- Fix the overlay in zh/: the build-time transforms (zh/translation-transform.cjs, zh/reclaude-transform.cjs, zh/telemetry-transform.cjs) and the anchors in zh/apply.cjs. Follow upstream's new code and keep every hook doing the same job as before.
- In upstream files (apps/...) you may only add or change lines that carry the comment \`${MARK}\`.
- Do not edit zh/*.test.cjs, zh/agent-repair.cjs, zh/UPSTREAM or zh/package*.json. The tests are the acceptance check; if one is wrong for the new upstream, say why and stop.
- Telemetry stays off. zh/telemetry-transform.cjs switches off everything upstream sends home (analytics, relay traces, mobile crash reports); zh/telemetry-surface.json fingerprints every upstream file that could send it. If zh/telemetry.test.cjs fails, run \`node zh/telemetry-surface.cjs\` and read \`git diff ${previous} ${tag} -- <file>\` for each file it lists. Anything that could now send data (a new endpoint, exporter, beacon, or a moved switch) must be switched off in zh/telemetry-transform.cjs. Only then run \`node zh/telemetry-surface.cjs --write\`. Never weaken a telemetry hook to make a test pass.
- Check with \`node zh/apply.cjs\` (must exit 0) and \`node --test ${TESTS}\` (must pass). Repeat until both pass.
- Do not commit; the pipeline reviews and commits your change.

Hooks whose anchors no longer match: ${hooks.length ? hooks.join(", ") : "none (see the failures)"}

Failures:
${failures}
${feedback ? `\nA previous attempt was rejected and reverted: ${feedback}\n` : ""}`;
}

/** Why the agent cannot run here, or null. */
function agentUnavailable() {
  const protocol = process.env.DEEPSEEK_PROTOCOL?.trim() || "anthropic";
  if (!process.env.DEEPSEEK_API_KEY) return "没有 DEEPSEEK_API_KEY";
  if (protocol !== "anthropic") return `Agent 需要 Anthropic 协议,DEEPSEEK_PROTOCOL=${protocol}`;
  return null;
}

/**
 * Runs Claude Code headless on DeepSeek with only `allowedTools`. With `capture`, returns the final
 * reply text (null when the CLI failed); otherwise streams the transcript to the log.
 */
function runClaude(prompt, allowedTools, { capture = false } = {}) {
  const base = process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com/anthropic";
  const model = process.env.DEEPSEEK_AGENT_MODEL?.trim() || process.env.DEEPSEEK_MODEL?.trim() || "deepseek-chat";
  // Only what the CLI needs: no tokens from the job leak into the agent's shell.
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C.UTF-8",
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: process.env.DEEPSEEK_API_KEY,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  const args = [
    "-p",
    prompt,
    "--bare",
    "--model",
    model,
    "--permission-mode",
    "dontAsk",
    "--tools",
    "Read,Grep,Glob,Edit,Write,Bash",
    ...(capture ? ["--output-format", "json"] : []),
    "--allowedTools",
    ...allowedTools,
  ];
  const result = spawnSync(process.env.CLAUDE_BIN || "claude", args, {
    cwd: ROOT,
    env,
    stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: AGENT_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    console.log(`::warning::Agent 没有正常结束:${result.error?.message ?? `退出码 ${result.status}`}`);
    return null;
  }
  if (!capture) return null;
  try {
    return String(JSON.parse(result.stdout).result ?? "");
  } catch {
    console.log(`::warning::读不懂 Agent 的输出:${tail(result.stdout, 2000)}`);
    return null;
  }
}

/** Puts zh/ and apps/ back to `snapshot` (a commit holding the pre-agent working tree). */
function revert(snapshot) {
  git("checkout", "-q", snapshot, "--", "zh", "apps");
  git("reset", "-q");
  git("clean", "-fdq", "--", "zh", "apps");
}

/** Null when the agent's change set passes every check, otherwise why it was rejected. */
function judge(snapshot) {
  git("add", "-A", "--", "zh", "apps");
  const files = git("diff", "--cached", "--name-only", snapshot).split("\n").filter(Boolean);
  if (files.length === 0) return "nothing was changed";
  const reason = rejectReason(files, git("diff", "--cached", "-U0", snapshot, "--", "apps"));
  if (reason) return reason;
  const surface = require("./telemetry-surface.cjs");
  const before = JSON.parse(git("show", `${snapshot}:zh/telemetry-surface.json`));
  const dropped = surface.droppedFiles(before, surface.readBaseline());
  if (dropped.length) return `files still upstream were dropped from zh/telemetry-surface.json: ${dropped.join(", ")}`;
  const apply = runApply();
  if (!apply.ok) return `node zh/apply.cjs still fails:\n${tail(apply.output, 3000)}`;
  const tests = runTests();
  if (!tests.ok) return `these tests still fail: ${failingTests(tests.output).join("; ") || tail(tests.output, 3000)}`;
  return null;
}

function writeOutputs({ fixed, degraded }) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `fixed=${fixed}\ndegraded=${degraded}\n`);
  }
}

function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

function main() {
  const [tag, previous, ...logs] = process.argv.slice(2);
  if (!tag || !previous) throw new Error("usage: node zh/agent-repair.cjs <tag> <previous tag> [failure log...]");
  const failures = logs
    .filter((file) => fs.existsSync(file))
    .map((file) => tail(fs.readFileSync(file, "utf8")))
    .join("\n\n");
  const snapshot = git("stash", "create").trim() || git("rev-parse", "HEAD").trim();

  let fixed = false;
  const unavailable = agentUnavailable();
  if (unavailable) console.log(`::warning::${unavailable},跳过 Agent 修复。`);
  else {
    let feedback = "";
    for (let attempt = 1; attempt <= ATTEMPTS && !fixed; attempt++) {
      console.log(`::group::Agent 第 ${attempt} 次`);
      runClaude(agentPrompt({ tag, previous, failures, hooks: missingHooks(), feedback }), ALLOWED_TOOLS);
      console.log("::endgroup::");
      feedback = judge(snapshot) ?? "";
      if (feedback) {
        console.log(`::warning::Agent 第 ${attempt} 次的修改不合格,已撤销:${feedback.split("\n")[0]}`);
        revert(snapshot);
      } else fixed = true;
    }
  }
  if (fixed) {
    git("add", "-A", "--", "zh", "apps");
    git("commit", "-q", "--no-verify", "-m", `fix(zh): Agent 修复 ${tag} 的覆盖层挂入点\n\n流水线里的 Agent 自动修复,apply.cjs 和覆盖层单测都已通过,请检查。`);
    summary(["## Agent 修复了覆盖层", "```diff", tail(git("show", "--format=", "HEAD"), 60_000), "```"]);
  }

  const apply = runApply();
  if (!apply.ok) {
    console.error(apply.output);
    console.log("::error::构建配置挂入点仍然缺失,没有覆盖层就不发布。");
    writeOutputs({ fixed, degraded: "" });
    process.exit(1);
  }
  const telemetryTests = run(["--test", "--test-reporter=tap", TELEMETRY_TESTS]);
  if (!telemetryTests.ok) {
    console.error(telemetryTests.output);
    console.log("::error::遥测关闭没有通过校验,本版不发布。");
    summary(["## 遥测关闭没有通过校验,本版不发布", "", "```", tail(telemetryTests.output, 20_000), "```"]);
    writeOutputs({ fixed, degraded: "" });
    process.exit(1);
  }
  const tests = runTests();
  let degraded = "";
  if (!tests.ok) {
    const hooks = missingHooks();
    degraded = (hooks.length ? hooks.map((hook) => path.basename(hook)) : failingTests(tests.output)).join(", ");
    degraded = degraded.replace(/\s+/g, " ").slice(0, 200) || "覆盖层单测未通过";
    console.log(`::warning::降级发布,这些挂入点本版不生效:${degraded}`);
    summary(["## 降级发布", "", `本版不生效的挂入点:${degraded}`, "", "```", tail(tests.output, 20_000), "```"]);
  }
  writeOutputs({ fixed, degraded });
}

if (require.main === module) main();

module.exports = { rejectReason, failingTests, missingHooks, agentUnavailable, runClaude, summary, tail, git, PROTECTED };
