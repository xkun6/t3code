// Wraps a Metro config so UI sources are localized when T3CODE_LOCALE=zh-Hans.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DICT_PATH, isEnabled } = require("./localize.cjs");

function dictionaryHash() {
  const files = [DICT_PATH, path.join(__dirname, "localize.cjs")];
  const hash = crypto.createHash("sha256");
  for (const file of files) hash.update(fs.readFileSync(file));
  return hash.digest("hex").slice(0, 16);
}

function withZhLocale(config) {
  if (!isEnabled()) return config;
  // Metro workers are separate processes; they find the wrapped transformer through the environment.
  process.env.T3CODE_ZH_UPSTREAM_TRANSFORMER = config.transformer.babelTransformerPath;
  return {
    ...config,
    transformer: {
      ...config.transformer,
      babelTransformerPath: path.join(__dirname, "metro-transformer.cjs"),
    },
    // Localized output depends on the dictionary, so it must not reuse cached transforms.
    cacheVersion: `${config.cacheVersion ?? ""}:zh-Hans:${dictionaryHash()}`,
  };
}

module.exports = { withZhLocale };
