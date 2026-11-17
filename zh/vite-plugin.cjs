// Vite / Rolldown plugins:
// - zhLocalePlugin: localizes UI sources before React and the compiler see them, and wires the
//   conversation-translation UI into the web app.
// - zhServerPlugin: wires Reclaude (`rec`) / Recodex (`recx`) support and conversation translation
//   into server bundles.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { localizeWithMap, isEnabled } = require("./localize.cjs");
const {
  RUNTIME_SPECIFIER,
  isReclaudeEnabled,
  transformReclaudeServerWithMap,
} = require("./reclaude-transform.cjs");
const translation = require("./translation-transform.cjs");

const VIRTUAL_RUNTIME_ID = `\0${RUNTIME_SPECIFIER}`;
const RUNTIME_FILE_PATH = path.join(__dirname, "reclaude-runtime.mjs");
const VIRTUAL_TRANSLATION_RUNTIME_ID = `\0${translation.RUNTIME_SPECIFIER}`;
const TRANSLATION_RUNTIME_FILE_PATH = path.join(__dirname, "translation-runtime.mjs");
const TRANSLATION_WEB_FILE_PATH = path.join(__dirname, "web", "translation.tsx");
// Not a file on disk: the id sits inside the web app so the module's imports resolve from there.
const ROOT = (process.env.T3CODE_ZH_ROOT || path.resolve(__dirname, "..")).split(path.sep).join("/");
const TRANSLATION_WEB_ID = `${ROOT}/apps/web/src/__zh__/translation.tsx`;

function zhLocalePlugin() {
  return {
    name: "t3code-zh-locale",
    enforce: "pre",
    resolveId(source) {
      if (source === translation.WEB_SPECIFIER) return TRANSLATION_WEB_ID;
      // The dev server asks again by URL (`/src/__zh__/translation.tsx`).
      const clean = source.split("?")[0].split("\\").join("/");
      return clean.endsWith("/__zh__/translation.tsx") ? TRANSLATION_WEB_ID : null;
    },
    load(id) {
      if (id.split("?")[0] === TRANSLATION_WEB_ID) return fs.readFileSync(TRANSLATION_WEB_FILE_PATH, "utf8");
      return null;
    },
    transform(code, id) {
      const file = id.split("?")[0];
      const translated = translation.transformTranslationWebWithMap(code, file);
      const source = translated?.map ? translated.code : code;
      const localized = isEnabled() ? localizeWithMap(source, file) : null;
      if (localized !== null) {
        // Both steps edit the same file only for the few translation targets; their maps are not chained.
        return { code: localized.code, map: translated?.map ? null : localized.map };
      }
      return translated?.map ? { code: translated.code, map: translated.map } : null;
    },
  };
}

function zhServerPlugin() {
  return {
    name: "t3code-zh-server-reclaude",
    enforce: "pre",
    resolveId(source) {
      if (source === RUNTIME_SPECIFIER) return VIRTUAL_RUNTIME_ID;
      if (source === translation.RUNTIME_SPECIFIER) return VIRTUAL_TRANSLATION_RUNTIME_ID;
      return null;
    },
    load(id) {
      if (id === VIRTUAL_RUNTIME_ID) {
        return fs.readFileSync(RUNTIME_FILE_PATH, "utf8");
      }
      if (id === VIRTUAL_TRANSLATION_RUNTIME_ID) {
        return fs.readFileSync(TRANSLATION_RUNTIME_FILE_PATH, "utf8");
      }
      return null;
    },
    transform(code, id) {
      const file = id.split("?")[0];
      // The two overlays target disjoint files.
      const result =
        (isReclaudeEnabled() ? transformReclaudeServerWithMap(code, file, { bundle: true }) : null) ??
        translation.transformTranslationServerWithMap(code, file);
      return result?.map ? { code: result.code, map: result.map } : null;
    },
  };
}

module.exports = { zhLocalePlugin, zhServerPlugin };
