// Reviews each upstream release for new ways of sending data home. The fingerprint in
// zh/telemetry-surface.cjs only finds code that still uses names we know, so this one does not rely on them:
// it collects every line upstream added that uses a network, URL or home-directory primitive (fetch,
// HttpClient, URL literals, homedir... which renaming cannot avoid) plus newly added dependencies, and a
// read-only agent classifies each. Telemetry on by default, or anything the agent cannot place, stops the
// release; files it confirms as telemetry join the fingerprint baseline, tracked whatever names they use.
// Never degrades: no agent or no verdict means no release. zh/TELEMETRY_AUDITED holds the last tag that passed.
// Usage: node zh/telemetry-audit.cjs <tag>
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { agentUnavailable, runAgent, summary, tail, git } = require("./agent-repair.cjs");
const surface = require("./telemetry-surface.cjs");

const ROOT = path.resolve(__dirname, "..");
const AUDITED_PATH = path.join(__dirname, "TELEMETRY_AUDITED");
const ATTEMPTS = 2;
// What ships: the apps the release builds and the packages they bundle.
const PATHSPECS = ["apps/server", "apps/web", "apps/desktop", "apps/mobile", "packages"];
const SOURCE = /\.(?:[cm]?[jt]sx?|kt|java|swift|mm?)$/;
const SKIP = /(?:\.(?:test|spec|e2e|stories)\.|\/(?:__tests__|tests?|e2e|fixtures?|scripts)\/|\/i18n\/|\/locales?\/)/;
const PRIMITIVES = [
  /\bfetch\s*\(/,
  /\bHttpClient(?:Request)?\b/,
  /\b(?:XMLHttpRequest|sendBeacon|EventSource|WebSocket)\b/,
  /\bnode:(?:https?|http2|net|tls|dgram|dns)\b/,
  /\b(?:URLSession|OkHttp\w*|HttpURLConnection)\b/,
  /\bhttps?:\/\/(?!localhost\b|127\.|0\.0\.0\.0|\[::1\]|example\.)[\w-]+(?:\.[\w-]+)+/i,
  /\bhomedir\s*\(/,
  /\b(?:Otlp\w*|OTEL_\w+|opentelemetry)\b/i,
];
const LINES_PER_FILE = 15;
const CANDIDATE_CHARS = 60_000;
const STATUSES = ["switched_off", "opt_in", "functional", "sends_by_default", "unsure"];
const TRACKED_STATUSES = new Set(["switched_off", "opt_in"]);

/** File → added lines that use a network, URL or home-directory primitive, from `git diff -U0`. */
function candidates(diff) {
  const found = new Map();
  let file = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.startsWith("+++ b/") ? line.slice(6) : null;
      continue;
    }
    if (!file || !SOURCE.test(file) || SKIP.test(`/${file}`)) continue;
    if (!line.startsWith("+") || !PRIMITIVES.some((pattern) => pattern.test(line))) continue;
    if (!found.has(file)) found.set(file, []);
    found.get(file).push(line.slice(1).trim().slice(0, 200));
  }
  return found;
}

/** `package.json → [dependency]` for dependencies `tag` has and `base` did not. */
function newDependencies(base, tag) {
  const manifests = git("ls-tree", "-r", "--name-only", tag, "--", ...PATHSPECS)
    .split("\n")
    .filter((file) => /(?:^|\/)package\.json$/.test(file) && !file.includes("node_modules/"));
  const deps = (ref, file) => {
    try {
      const json = JSON.parse(git("show", `${ref}:${file}`));
      return new Set(["dependencies", "optionalDependencies", "peerDependencies"].flatMap((key) => Object.keys(json[key] ?? {})));
    } catch {
      return new Set();
    }
  };
  const added = new Map();
  for (const file of manifests) {
    const before = deps(base, file);
    const fresh = [...deps(tag, file)].filter((name) => !before.has(name));
    if (fresh.length) added.set(file, fresh);
  }
  return added;
}

function formatCandidates(found) {
  let out = "";
  const omitted = [];
  for (const [file, lines] of found) {
    const block = `${file}\n${lines.slice(0, LINES_PER_FILE).map((line) => `  + ${line}`).join("\n")}${
      lines.length > LINES_PER_FILE ? `\n  (+${lines.length - LINES_PER_FILE} more lines)` : ""
    }\n`;
    if (out.length + block.length > CANDIDATE_CHARS) omitted.push(`${file} (${lines.length} lines)`);
    else out += block;
  }
  if (omitted.length) out += `\nNot shown, read them with git diff:\n${omitted.join("\n")}\n`;
  return out;
}

function auditPrompt({ base, tag, found, deps, feedback }) {
  const depText = [...deps].map(([file, names]) => `${file}: ${names.join(", ")}`).join("\n");
  return `You are auditing upstream t3code ${base}..${tag} for a fork that must ship with all telemetry switched off.
Read zh/telemetry-transform.cjs first: it lists what the fork already switches off at build time and how.

Telemetry means data about the user, their machine, their usage, errors or performance sent anywhere the user did not choose to talk to: the T3 Code project's own services used for analytics, tracing or crash reports, analytics and error-tracking vendors, tracing backends. Reading login or identity files to attach to such reports counts too.
Not telemetry: traffic the user's own action needs (model provider APIs, git hosts, issue trackers or integrations the user connected, the T3 Connect relay once the user turns it on, update checks), and talking to localhost or the user's own server.

Below are the lines upstream added in this range that use the network, URLs or the home directory, and the dependencies it added. For each one, read enough code (\`git diff ${base} ${tag} -- <file>\`, \`git show ${tag}:<file>\`, Read, Grep) to know what data goes where and what turns it on. Follow calls into other files when the sender lives elsewhere, and look into anything these lines suggest that the list missed. A new dependency counts when it is an analytics, crash-reporting or tracing SDK.

Classify each finding:
- switched_off: telemetry, but a hook in zh/telemetry-transform.cjs already stops it in the fork's build (name the hook).
- opt_in: telemetry that sends nothing until the user configures an endpoint or turns a setting on.
- functional: not telemetry (see above).
- sends_by_default: telemetry that is on in a default build of this fork.
- unsure: you read the code and still cannot tell.

Give at least one finding for every candidate file and every new dependency (use the package.json path as file); group lines of one mechanism in one finding. Do not edit anything.

End your reply with exactly one fenced json block and nothing after it:
\`\`\`json
{"findings":[{"file":"apps/...","what":"...","destination":"...","status":"${STATUSES.join("|")}","reason":"..."}]}
\`\`\`
${feedback ? `\nYour previous answer was rejected: ${feedback}\n` : ""}
New dependencies:
${depText || "(none)"}

Candidate lines:
${formatCandidates(found)}`;
}

/** Findings from the agent's reply, or a string saying why the reply is unusable. */
function parseVerdict(text, expectedFiles) {
  const blocks = [...String(text ?? "").matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!blocks.length) return "no ```json block at the end of the reply";
  let findings;
  try {
    findings = JSON.parse(blocks.at(-1)[1]).findings;
  } catch (error) {
    return `the json block does not parse: ${error.message}`;
  }
  if (!Array.isArray(findings)) return "the json has no findings array";
  for (const finding of findings) {
    if (typeof finding?.file !== "string" || !STATUSES.includes(finding.status)) {
      return `a finding has no file or an unknown status: ${JSON.stringify(finding).slice(0, 200)}`;
    }
  }
  const covered = new Set(findings.map((finding) => finding.file));
  const missed = expectedFiles.filter((file) => !covered.has(file));
  if (missed.length) return `these files have no finding: ${missed.join(", ")}`;
  return findings;
}

/** Findings that stop the release, and files to add to the fingerprint baseline. */
function decide(findings) {
  return {
    blocking: findings.filter((finding) => !TRACKED_STATUSES.has(finding.status) && finding.status !== "functional"),
    tracked: [...new Set(findings.filter((finding) => TRACKED_STATUSES.has(finding.status)).map((finding) => finding.file))],
  };
}

function report(title, findings) {
  const rows = findings.map(
    (f) => `| ${f.status} | \`${f.file}\` | ${[f.what, f.destination, f.reason].filter(Boolean).join(" · ").replace(/[|\n]/g, " ")} |`,
  );
  summary([`## ${title}`, "", "| 结论 | 文件 | 说明 |", "| --- | --- | --- |", ...rows, ""]);
  for (const row of rows) console.log(row);
}

function fail(message) {
  console.log(`::error::${message}`);
  summary([`## 遥测审查没有通过,本版不发布`, "", message, ""]);
  process.exit(1);
}

function main() {
  const tag = process.argv[2];
  if (!tag) throw new Error("usage: node zh/telemetry-audit.cjs <tag>");
  const base = fs.readFileSync(AUDITED_PATH, "utf8").trim();
  if (base === tag) {
    console.log(`${tag} 已经审查过。`);
    return;
  }
  const pending = surface.diffSurface();
  if (Object.values(pending).some((files) => files.length)) {
    fail(`指纹基线还有没审过的改动,先让 zh/telemetry.test.cjs 通过:${JSON.stringify(pending)}`);
  }

  const found = candidates(git("diff", "-U0", "--no-color", base, tag, "--", ...PATHSPECS));
  const deps = newDependencies(base, tag);
  console.log(`${base}..${tag}:${found.size} 个文件有联网相关的新增行,${deps.size} 个 package.json 加了依赖。`);
  let findings = [];
  if (found.size || deps.size) {
    const unavailable = agentUnavailable();
    if (unavailable) fail(`${unavailable},遥测审查跑不起来。`);
    const expected = [...found.keys(), ...deps.keys()];
    let feedback = "";
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      console.log(`::group::遥测审查 Agent 第 ${attempt} 次`);
      const reply = runAgent(auditPrompt({ base, tag, found, deps, feedback }), "read-only", { capture: true });
      console.log(tail(reply ?? "(没有输出)", 20_000));
      console.log("::endgroup::");
      const verdict = reply === null ? "the agent did not finish" : parseVerdict(reply, expected);
      if (Array.isArray(verdict)) {
        findings = verdict;
        feedback = "";
        break;
      }
      feedback = verdict;
      console.log(`::warning::遥测审查第 ${attempt} 次的结论不可用:${verdict}`);
    }
    if (feedback) fail(`遥测审查 Agent 没有给出可用的结论:${feedback}`);
  }

  const { blocking, tracked } = decide(findings);
  if (blocking.length) {
    report(`遥测审查:${base}..${tag} 有默认开着或看不清的外发,本版不发布`, blocking);
    fail("在 zh/telemetry-transform.cjs 里关掉上面这些外发(或人工确认不是遥测),再手动运行流水线重审。");
  }
  const baseline = surface.readBaseline();
  const added = tracked.filter((file) => !(file in baseline) && fs.existsSync(path.join(ROOT, file)));
  if (added.length) {
    const hashes = surface.scan(ROOT, added);
    surface.writeBaseline(
      Object.fromEntries(
        Object.entries({ ...baseline, ...Object.fromEntries(added.map((file) => [file, hashes[file]])) }).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ),
    );
  }
  fs.writeFileSync(AUDITED_PATH, `${tag}\n`);
  report(`遥测审查通过:${base}..${tag}${added.length ? `,指纹基线新增 ${added.join(", ")}` : ""}`, findings);
}

if (require.main === module) main();

module.exports = { candidates, parseVerdict, decide, auditPrompt };
