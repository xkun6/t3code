// Wraps a Metro config so UI sources are localized when T3CODE_LOCALE=zh-Hans and conversation
// translation is wired in unless T3CODE_TRANSLATION=0.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DICT_PATH, isEnabled } = require("./localize.cjs");
const { MOBILE_SPECIFIER, isTranslationEnabled } = require("./translation-transform.cjs");

const MOBILE_MODULE_PATH = path.join(__dirname, "mobile", "translation.tsx");

function transformHash() {
  const files = [
    DICT_PATH,
    path.join(__dirname, "localize.cjs"),
    path.join(__dirname, "translation-transform.cjs"),
  ];
  const hash = crypto.createHash("sha256");
  hash.update(`${isEnabled()}:${isTranslationEnabled()}`);
  for (const file of files) hash.update(fs.readFileSync(file));
  return hash.digest("hex").slice(0, 16);
}

/**
 * Serves the translation UI module and resolves its imports as if it lived at
 * apps/mobile/src/__zh__/translation.tsx, after any resolver already configured (Uniwind's).
 */
function withTranslationModule(resolver, projectRoot) {
  const origin = path.join(projectRoot, "src", "__zh__", "translation.tsx");
  const previous = resolver?.resolveRequest;
  return {
    ...resolver,
    resolveRequest(context, moduleName, platform) {
      if (moduleName === MOBILE_SPECIFIER) return { type: "sourceFile", filePath: MOBILE_MODULE_PATH };
      const next = context.originModulePath === MOBILE_MODULE_PATH ? { ...context, originModulePath: origin } : context;
      return (previous ?? context.resolveRequest)(next, moduleName, platform);
    },
  };
}

function withZhLocale(config) {
  const translation = isTranslationEnabled();
  if (!isEnabled() && !translation) return config;
  // Metro workers are separate processes; they find the wrapped transformer through the environment.
  process.env.T3CODE_ZH_UPSTREAM_TRANSFORMER = config.transformer.babelTransformerPath;
  return {
    ...config,
    resolver: translation ? withTranslationModule(config.resolver, config.projectRoot) : config.resolver,
    transformer: {
      ...config.transformer,
      babelTransformerPath: path.join(__dirname, "metro-transformer.cjs"),
    },
    // The output depends on the dictionary and the hooks, so it must not reuse cached transforms.
    cacheVersion: `${config.cacheVersion ?? ""}:zh:${transformHash()}`,
  };
}

module.exports = { withZhLocale, MOBILE_MODULE_PATH };
