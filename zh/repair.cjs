// Asks the model to wire the overlay into files whose anchors apply.cjs could not find.
// Accepts an edit only when it keeps every original line in order and adds the marker,
// so a bad answer can add code but never delete or rewrite upstream code.
// Env: same as translate.cjs. Usage: node zh/repair.cjs
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = process.env.T3CODE_ZH_ROOT || path.resolve(__dirname, "..");
const FAILURES_PATH = path.join(__dirname, ".cache", "apply-failures.json");
const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
const baseUrl = (process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/+$/, "");
const model = process.env.DEEPSEEK_MODEL?.trim() || "deepseek-chat";

async function askForFile(failure, source, feedback) {
  const prompt = [
    `File: ${failure.file}`,
    `Goal: ${failure.goal}`,
    `Rules: only ADD lines. Do not change, reorder or remove any existing line. Put the comment \`${failure.mark}\` on every line you add (use // comments).`,
    feedback ? `Your previous answer was rejected: ${feedback}` : "",
    'Reply with a JSON object {"content": "<the complete new file>"} and nothing else.',
    "",
    source,
  ].join("\n");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You make minimal, additive edits to build configuration files." },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return JSON.parse((await response.json()).choices[0].message.content).content;
}

/** Null when `next` keeps every line of `original` in order and only adds marked lines. */
function rejectReason(original, next, mark) {
  if (typeof next !== "string") return "no content";
  const before = original.split("\n");
  const after = next.split("\n");
  let index = 0;
  for (const line of after) {
    if (index < before.length && line === before[index]) index += 1;
    else if (!line.includes(mark)) {
      return `original line ${index + 1} (${JSON.stringify(before[index]?.slice(0, 120))}) was changed or removed, or an added line lacks the marker: ${JSON.stringify(line.slice(0, 120))}`;
    }
  }
  if (index < before.length) return `original line ${index + 1} was changed or removed`;
  if (!next.includes(mark)) return "nothing was added";
  return null;
}

async function main() {
  const failures = fs.existsSync(FAILURES_PATH) ? JSON.parse(fs.readFileSync(FAILURES_PATH, "utf8")) : [];
  if (failures.length === 0) return;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set.");
  for (const failure of failures) {
    const full = path.join(ROOT, failure.file);
    const source = fs.readFileSync(full, "utf8");
    let feedback = "";
    let accepted = false;
    for (let attempt = 1; attempt <= 3 && !accepted; attempt++) {
      const next = await askForFile(failure, source, feedback);
      feedback = rejectReason(source, next, failure.mark) ?? "";
      if (!feedback) {
        fs.writeFileSync(full, next);
        accepted = true;
        console.log(`repaired ${failure.file} on attempt ${attempt}`);
      } else console.error(`attempt ${attempt} for ${failure.file} rejected: ${feedback}`);
    }
    if (!accepted) throw new Error(`could not repair ${failure.file}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
