"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseConflicts, rejectReason, mergeUpstream, MARK } = require("./merge-upstream.cjs");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
}

function write(cwd, file, text) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
}

/** A repo whose `zh` branch adds a marked hook to config.ts, with upstream tag v2 changing the same line. */
function makeRepo({ upstreamConfig, upstreamExtra = {} }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "zh-merge-"));
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "core.autocrlf", "false");
  write(cwd, "config.ts", "import a from 'a';\nexport default [a()];\n");
  write(cwd, ".github/workflows/ci.yml", "on: push\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "v1");
  git(cwd, "tag", "v1");

  git(cwd, "checkout", "-q", "-b", "zh");
  write(cwd, "config.ts", `import a from 'a';\nimport zh from 'zh'; // ${MARK}\nexport default [zh(), a()]; // ${MARK}\n`);
  write(cwd, "zh/UPSTREAM", "v1\n");
  write(cwd, ".github/workflows/zh-release.yml", "on: schedule\n");
  git(cwd, "rm", "-q", ".github/workflows/ci.yml");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "zh");

  git(cwd, "checkout", "-q", "main");
  write(cwd, "config.ts", upstreamConfig);
  write(cwd, ".github/workflows/ci.yml", "on: [push, pull_request]\n");
  for (const [file, text] of Object.entries(upstreamExtra)) write(cwd, file, text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "v2");
  git(cwd, "tag", "-a", "v2", "-m", "v2");
  git(cwd, "checkout", "-q", "zh");
  return cwd;
}

async function merge(cwd, askModel) {
  const previous = { ...process.env };
  Object.assign(process.env, GIT_ENV);
  try {
    return await mergeUpstream({ cwd, tag: "v2", askModel });
  } finally {
    for (const key of Object.keys(GIT_ENV)) if (!(key in previous)) delete process.env[key];
  }
}

test("parseConflicts splits diff3 hunks", () => {
  const parts = parseConflicts("a\n<<<<<<< HEAD\nours\n||||||| base\nbase\n=======\ntheirs\n>>>>>>> v2\nb");
  assert.deepEqual(parts, [
    { type: "text", lines: ["a"] },
    { type: "hunk", ours: ["ours"], base: ["base"], theirs: ["theirs"] },
    { type: "text", lines: ["b"] },
  ]);
});

test("rejectReason refuses leftover markers and dropped overlay lines", () => {
  const hunk = { ours: [`x(); // ${MARK}`], base: [], theirs: ["y();"] };
  assert.match(rejectReason(hunk, "y();\n======="), /conflict marker/);
  assert.match(rejectReason(hunk, "y();"), /keeps only 0/);
  assert.equal(rejectReason(hunk, `y();\nx(); // ${MARK}`), null);
});

test("clean merge drops upstream workflows and records the tag", async () => {
  const cwd = makeRepo({
    upstreamConfig: "import a from 'a';\nexport default [a()];\n",
    upstreamExtra: { "src/new.ts": "new\n", ".github/workflows/added.yml": "on: push\n" },
  });
  const report = await merge(cwd, null);
  assert.equal(report.error, null);
  assert.deepEqual(report.aiResolved, []);
  assert.equal(fs.readFileSync(path.join(cwd, "zh/UPSTREAM"), "utf8"), "v2\n");
  const files = git(cwd, "ls-files").split("\n");
  assert.ok(files.includes("src/new.ts"));
  assert.ok(files.includes(".github/workflows/zh-release.yml"));
  assert.ok(!files.includes(".github/workflows/ci.yml"));
  assert.ok(!files.includes(".github/workflows/added.yml"));
  assert.match(git(cwd, "log", "-1", "--format=%s"), /合并上游 v2/);
  assert.equal(git(cwd, "status", "--porcelain"), "");
});

test("conflicts are resolved by the model and listed in the commit", async () => {
  const cwd = makeRepo({ upstreamConfig: "import a from 'a';\nexport default [a({ fast: true })];\n" });
  const prompts = [];
  const report = await merge(cwd, async ({ user }) => {
    prompts.push(user);
    return { resolved: `import zh from 'zh'; // ${MARK}\nexport default [zh(), a({ fast: true })]; // ${MARK}` };
  });
  assert.equal(report.error, null);
  assert.deepEqual(report.aiResolved, [{ file: "config.ts", hunks: 1 }]);
  assert.match(prompts[0], /THEIRS/);
  assert.equal(
    fs.readFileSync(path.join(cwd, "config.ts"), "utf8"),
    `import a from 'a';\nimport zh from 'zh'; // ${MARK}\nexport default [zh(), a({ fast: true })]; // ${MARK}\n`,
  );
  assert.match(git(cwd, "log", "-1", "--format=%B"), /config\.ts \(1 处\)/);
});

test("a resolution that drops our hook is retried, then the merge is aborted", async () => {
  const cwd = makeRepo({ upstreamConfig: "import a from 'a';\nexport default [a({ fast: true })];\n" });
  const head = git(cwd, "rev-parse", "HEAD");
  let calls = 0;
  const report = await merge(cwd, async () => {
    calls += 1;
    return { resolved: "export default [a({ fast: true })];" };
  });
  assert.equal(calls, 3);
  assert.match(report.error, /could not resolve/);
  assert.equal(git(cwd, "rev-parse", "HEAD"), head);
  assert.equal(git(cwd, "status", "--porcelain"), "");
});

test("conflicts without a model fail the merge", async () => {
  const cwd = makeRepo({ upstreamConfig: "import a from 'a';\nexport default [a({ fast: true })];\n" });
  const report = await merge(cwd, null);
  assert.match(report.error, /no model is configured/);
  assert.equal(git(cwd, "status", "--porcelain"), "");
});
