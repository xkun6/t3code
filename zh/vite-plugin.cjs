// Vite / Rolldown plugins:
// - zhLocalePlugin: localizes UI sources before React and the compiler see them.
// - zhServerPlugin: wires Reclaude (`rec`) and Recodex (`recx`) support into server bundles.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { localizeWithMap, isEnabled } = require("./localize.cjs");
const {
  RUNTIME_SPECIFIER,
  isReclaudeEnabled,
  transformReclaudeServerWithMap,
} = require("./reclaude-transform.cjs");

const VIRTUAL_RUNTIME_ID = `\0${RUNTIME_SPECIFIER}`;
const RUNTIME_FILE_PATH = path.join(__dirname, "reclaude-runtime.mjs");

function zhLocalePlugin() {
  return {
    name: "t3code-zh-locale",
    enforce: "pre",
    transform(code, id) {
      if (!isEnabled()) return null;
      const file = id.split("?")[0];
      const result = localizeWithMap(code, file);
      return result === null ? null : { code: result.code, map: result.map };
    },
  };
}

function zhServerPlugin() {
  return {
    name: "t3code-zh-server-reclaude",
    enforce: "pre",
    resolveId(source) {
      if (source === RUNTIME_SPECIFIER) return VIRTUAL_RUNTIME_ID;
      return null;
    },
    load(id) {
      if (id === VIRTUAL_RUNTIME_ID) {
        return fs.readFileSync(RUNTIME_FILE_PATH, "utf8");
      }
      return null;
    },
    transform(code, id) {
      if (!isReclaudeEnabled()) return null;
      const file = id.split("?")[0];
      const result = transformReclaudeServerWithMap(code, file, { bundle: true });
      return result === null ? null : { code: result.code, map: result.map };
    },
  };
}

module.exports = { zhLocalePlugin, zhServerPlugin };
