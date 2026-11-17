// Merges an upstream release tag into the zh fork branch and commits the merge.
// - Upstream workflow files are dropped: the fork only runs its own .github/workflows/zh-*.yml.
// - Other conflicts go to the model one hunk at a time (diff3 style). A resolution is accepted only
//   when it has no conflict markers and keeps at least as many overlay-marked lines as our side had,
//   so the code outside the conflict hunks is never touched and our hooks cannot silently vanish.
// - Anything the model cannot resolve (or a file deleted on one side) aborts the merge.
// Writes zh/.cache/merge-report.json and, in GitHub Actions, the step summary and outputs.
// Env: see llm.cjs. Usage: node zh/merge-upstream.cjs <tag>   (the tag must already be fetched)
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const MARK = "t3code-zh-overlay";
const CONTEXT_LINES = 40;
const MAX_FILE_BYTES = 400_000;
const MAX_HUNK_CHARS = 60_000;
const OWN_WORKFLOW = /^\.github\/workflows\/zh-[^/]*\.ya?ml$/;
const MARKER_LINE = /^(<{7}|\|{7}|={7}|>{7})(\s|$)/;

const SYSTEM_PROMPT = `You resolve git merge conflicts in a fork of an open-source app.
OURS is the fork: upstream code plus a few small hooks for a Chinese localisation overlay; every line the fork adds carries the comment \`${MARK}\`.
THEIRS is the new upstream release. BASE is the previous upstream release.
Take upstream's changes in full, then re-apply the fork's hooks on top of them so they keep doing the same job.
Keep the \`${MARK}\` comment on every line that comes from the fork. Never invent code that is in neither side.
Reply with a JSON object {"resolved": "<the text that replaces the whole conflict block>"} and nothing else.`;

function git(cwd, args, options = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
}

/** Splits a diff3-style conflicted file into text segments and conflict hunks. */
function parseConflicts(text) {
  const lines = text.split("\n");
  const parts = [];
  let plain = [];
  let hunk = null;
  let section = null;
  for (const line of lines) {
    if (hunk === null && line.startsWith("<<<<<<<")) {
      parts.push({ type: "text", lines: plain });
      plain = [];
      hunk = { type: "hunk", ours: [], base: [], theirs: [] };
      section = "ours";
    } else if (hunk && section === "ours" && line.startsWith("|||||||")) section = "base";
    else if (hunk && (section === "ours" || section === "base") && line.startsWith("=======")) section = "theirs";
    else if (hunk && section === "theirs" && line.startsWith(">>>>>>>")) {
      parts.push(hunk);
      hunk = null;
      section = null;
    } else if (hunk) hunk[section].push(line);
    else plain.push(line);
  }
  if (hunk) throw new Error("unterminated conflict block");
  parts.push({ type: "text", lines: plain });
  return parts;
}

function countMark(lines) {
  return lines.filter((line) => line.includes(MARK)).length;
}

/** Null when `resolved` may replace `hunk`, otherwise why not. */
function rejectReason(hunk, resolved) {
  if (typeof resolved !== "string") return "no resolved text";
  const bad = resolved.split("\n").find((line) => MARKER_LINE.test(line));
  if (bad !== undefined) return `the resolution still contains a conflict marker line: ${JSON.stringify(bad)}`;
  const need = countMark(hunk.ours);
  const have = countMark(resolved.split("\n"));
  if (have < need) return `our side has ${need} line(s) marked ${MARK} but the resolution keeps only ${have}`;
  return null;
}

function hunkPrompt({ file, before, hunk, after, feedback }) {
  return [
    `File: ${file}`,
    feedback ? `Your previous answer was rejected: ${feedback}` : "",
    "",
    "Context before the conflict:",
    "```",
    before.join("\n"),
    "```",
    "OURS (fork):",
    "```",
    hunk.ours.join("\n"),
    "```",
    "BASE (previous upstream release):",
    "```",
    hunk.base.join("\n"),
    "```",
    "THEIRS (new upstream release):",
    "```",
    hunk.theirs.join("\n"),
    "```",
    "Context after the conflict:",
    "```",
    after.join("\n"),
    "```",
  ].join("\n");
}

/** Resolves every hunk of one conflicted file; returns the new file text. */
async function resolveFile(file, text, askModel) {
  const parts = parseConflicts(text);
  const out = [];
  let hunks = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.type === "text") {
      out.push(...part.lines);
      continue;
    }
    const size = part.ours.join("\n").length + part.theirs.join("\n").length + part.base.join("\n").length;
    if (size > MAX_HUNK_CHARS) throw new Error(`${file}: a conflict block is too large for automatic resolution`);
    const before = out.slice(-CONTEXT_LINES);
    const following = parts[i + 1]?.type === "text" ? parts[i + 1].lines : [];
    const after = following.slice(0, CONTEXT_LINES);
    let feedback = "";
    let accepted = null;
    for (let attempt = 1; attempt <= 3 && accepted === null; attempt++) {
      const reply = await askModel({
        system: SYSTEM_PROMPT,
        user: hunkPrompt({ file, before, hunk: part, after, feedback }),
      });
      const resolved = reply?.resolved;
      feedback = rejectReason(part, resolved) ?? "";
      if (!feedback) accepted = resolved;
      else console.error(`${file}: attempt ${attempt} rejected: ${feedback}`);
    }
    if (accepted === null) throw new Error(`${file}: the model could not resolve a conflict block`);
    out.push(...(accepted === "" ? [] : accepted.split("\n")));
    hunks += 1;
  }
  return { text: out.join("\n"), hunks };
}

function unmergedFiles(cwd) {
  return [...new Set(git(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"]).split("\0").filter(Boolean))];
}

/** Every path the merge result would have under .github/workflows that is not one of ours. */
function upstreamWorkflows(cwd) {
  const files = git(cwd, ["ls-files", "-z", "--", ".github/workflows"]).split("\0").filter(Boolean);
  return [...new Set(files)].filter((file) => !OWN_WORKFLOW.test(file));
}

/**
 * Merges `tag` into HEAD and commits. `askModel({system, user})` returns the model's JSON object;
 * null means no model is configured, so any real conflict fails the merge.
 */
async function mergeUpstream({ cwd, tag, askModel }) {
  const report = { tag, aiResolved: [], droppedWorkflows: [], error: null };
  const merge = spawnSync(
    "git",
    ["-c", "merge.conflictStyle=diff3", "merge", "--no-ff", "--no-commit", `${tag}^{commit}`],
    { cwd, encoding: "utf8" },
  );
  if (merge.status !== 0 && unmergedFiles(cwd).length === 0) {
    report.error = `git merge failed: ${(merge.stderr || merge.stdout).trim()}`;
    return report;
  }
  try {
    report.droppedWorkflows = upstreamWorkflows(cwd);
    if (report.droppedWorkflows.length > 0) git(cwd, ["rm", "-q", "-f", "--", ...report.droppedWorkflows]);

    for (const file of unmergedFiles(cwd)) {
      const full = path.join(cwd, file);
      if (!fs.existsSync(full)) throw new Error(`${file}: deleted on one side and changed on the other; resolve it by hand`);
      const buffer = fs.readFileSync(full);
      if (buffer.includes(0)) throw new Error(`${file}: binary conflict; resolve it by hand`);
      if (buffer.length > MAX_FILE_BYTES) throw new Error(`${file}: too large for automatic resolution`);
      const text = buffer.toString("utf8");
      if (!text.split("\n").some((line) => line.startsWith("<<<<<<<"))) {
        throw new Error(`${file}: conflict without conflict markers (rename or delete); resolve it by hand`);
      }
      if (!askModel) throw new Error(`${file}: has conflicts and no model is configured (DEEPSEEK_API_KEY)`);
      const { text: resolved, hunks } = await resolveFile(file, text, askModel);
      fs.writeFileSync(full, resolved);
      git(cwd, ["add", "--", file]);
      report.aiResolved.push({ file, hunks });
      console.log(`resolved ${file} (${hunks} conflict block(s))`);
    }

    fs.writeFileSync(path.join(cwd, "zh", "UPSTREAM"), `${tag}\n`);
    git(cwd, ["add", "--", "zh/UPSTREAM"]);
    const body = report.aiResolved.length
      ? `\n\nAI 解决了这些文件的冲突,请检查:\n${report.aiResolved.map((r) => `- ${r.file} (${r.hunks} 处)`).join("\n")}`
      : "";
    git(cwd, ["commit", "-q", "--no-verify", "-m", `merge(zh): 合并上游 ${tag}${body}`]);
  } catch (error) {
    report.error = error.message;
    spawnSync("git", ["merge", "--abort"], { cwd });
  }
  return report;
}

function writeGithubOutputs(report) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `ai_resolved=${report.aiResolved.length}\n`);
  }
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const lines = [`## 合并上游 ${report.tag}`];
  if (report.error) lines.push("", `合并失败:${report.error}`);
  if (report.aiResolved.length) {
    lines.push("", "AI 解决了这些冲突,请检查合并提交:", ...report.aiResolved.map((r) => `- \`${r.file}\` (${r.hunks} 处)`));
  }
  if (report.droppedWorkflows.length) lines.push("", `丢弃了 ${report.droppedWorkflows.length} 个上游 workflow 文件。`);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}

async function main() {
  const tag = process.argv[2];
  if (!tag) throw new Error("usage: node zh/merge-upstream.cjs <tag>");
  const cwd = path.resolve(__dirname, "..");
  const askModel = process.env.DEEPSEEK_API_KEY?.trim() ? require("./llm.cjs").completeJson : null;
  const report = await mergeUpstream({ cwd, tag, askModel });
  fs.mkdirSync(path.join(__dirname, ".cache"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, ".cache", "merge-report.json"), JSON.stringify(report, null, 2) + "\n");
  writeGithubOutputs(report);
  if (report.error) {
    console.error(`::error::${report.error}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = { parseConflicts, rejectReason, resolveFile, mergeUpstream, MARK };
