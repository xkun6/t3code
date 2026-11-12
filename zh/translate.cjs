// Translates the strings extract.cjs reported missing (DeepSeek by default; see llm.cjs for the
// protocol and environment) and merges the results into locales/zh-Hans.json.
// Usage: node zh/translate.cjs [--missing zh/.cache/missing.json] [--limit N]
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DICT_PATH, checkTranslation } = require("./localize.cjs");
const { completeJson, protocol, model } = require("./llm.cjs");

const BATCH_SIZE = 60;
const CONCURRENCY = 4;

const guide = fs.readFileSync(path.join(__dirname, "TRANSLATION_GUIDE.md"), "utf8");
const SYSTEM_PROMPT = `${guide}

## 输出格式

用户会给你一个 JSON 数组，每项是 {"k": 英文原文, "f": 所在源文件（只作语境参考）}。
有的项带 "fix" 字段，说明你上次给这一项的翻译哪里不合格，这次要改正。
只返回一个 JSON 对象，键是每一项的 k（一字不差），值是中文翻译。不要输出其他任何内容。`;

function readDictionary() {
  return fs.existsSync(DICT_PATH) ? JSON.parse(fs.readFileSync(DICT_PATH, "utf8")) : {};
}

function writeDictionary(dictionary) {
  const sorted = Object.fromEntries(Object.entries(dictionary).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const temp = `${DICT_PATH}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(sorted, null, 2) + "\n");
  fs.renameSync(temp, DICT_PATH);
}

/** Translates one batch; entries that fail validation are retried once with the reason attached. */
async function translateBatch(entries) {
  const accepted = {};
  let pending = entries;
  for (let round = 0; round < 2 && pending.length > 0; round++) {
    const request = pending.map((entry) => ({ k: entry.key, f: entry.files[0], ...(entry.problem ? { fix: entry.problem } : {}) }));
    const result = await completeJson({ system: SYSTEM_PROMPT, user: JSON.stringify(request), temperature: 0.2 });
    const retry = [];
    for (const entry of pending) {
      const translation = result?.[entry.key];
      const problem = checkTranslation(entry.key, translation);
      if (problem === null) accepted[entry.key] = translation;
      else retry.push({ ...entry, problem: `上次的翻译不合格（${problem}），请修正` });
    }
    pending = retry;
  }
  return { accepted, rejected: pending };
}

async function main() {
  const args = process.argv.slice(2);
  const missingIndex = args.indexOf("--missing");
  const limitIndex = args.indexOf("--limit");
  const missingPath = missingIndex >= 0 ? args[missingIndex + 1] : path.join(__dirname, ".cache", "missing.json");
  let missing = JSON.parse(fs.readFileSync(missingPath, "utf8"));
  if (limitIndex >= 0) missing = missing.slice(0, Number(args[limitIndex + 1]));
  if (missing.length === 0) {
    console.log("Nothing to translate.");
    return;
  }

  const batches = [];
  for (let i = 0; i < missing.length; i += BATCH_SIZE) batches.push(missing.slice(i, i + BATCH_SIZE));
  console.log(`Translating ${missing.length} strings in ${batches.length} batches with ${model} (${protocol}).`);

  const dictionary = readDictionary();
  const rejected = [];
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      try {
        const result = await translateBatch(batch);
        Object.assign(dictionary, result.accepted);
        rejected.push(...result.rejected);
        // Persist after every batch so an interrupted run keeps what it paid for.
        writeDictionary(dictionary);
      } catch (error) {
        console.error(`batch failed: ${error.message}`);
        rejected.push(...batch);
      }
      done += 1;
      if (done % 10 === 0 || done === batches.length) console.log(`  ${done}/${batches.length} batches`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`Translated ${missing.length - rejected.length}, left in English ${rejected.length}.`);
  for (const entry of rejected.slice(0, 20)) console.log(`  untranslated: ${JSON.stringify(entry.key)}`);
  // More than a fifth failing (and more than a handful) means the API or prompt is broken, not a few odd strings.
  if (rejected.length > Math.max(5, missing.length / 5)) process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
