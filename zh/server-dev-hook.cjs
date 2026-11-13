// Node module loader hook for unbundled `vp run dev` (`node --watch src/bin.ts`),
// applying the exact same server AST transforms used by `zhServerPlugin` in `vp pack`:
// Reclaude / Recodex support and conversation translation.
"use strict";

const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");
const {
  RUNTIME_SPECIFIER,
  isReclaudeEnabled,
  transformReclaudeServer,
} = require("./reclaude-transform.cjs");
const translation = require("./translation-transform.cjs");

const RUNTIME_URL = pathToFileURL(path.join(__dirname, "reclaude-runtime.mjs")).href;
const TRANSLATION_RUNTIME_URL = pathToFileURL(path.join(__dirname, "translation-runtime.mjs")).href;
let registered = false;

function register(nodeModule) {
  if (
    registered ||
    (!isReclaudeEnabled() && !translation.isTranslationEnabled()) ||
    typeof nodeModule?.registerHooks !== "function"
  ) {
    return;
  }
  registered = true;
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === RUNTIME_SPECIFIER) {
        return { url: RUNTIME_URL, shortCircuit: true };
      }
      if (specifier === translation.RUNTIME_SPECIFIER) {
        return { url: TRANSLATION_RUNTIME_URL, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (!url.startsWith("file://") || (!url.endsWith(".ts") && !url.endsWith(".tsx"))) {
        return loaded;
      }
      const filePath = fileURLToPath(url);
      const rawSource =
        Buffer.isBuffer(loaded.source) || loaded.source instanceof Uint8Array
          ? Buffer.from(loaded.source).toString("utf8")
          : typeof loaded.source === "string"
            ? loaded.source
            : null;
      if (rawSource === null) return loaded;
      // The two overlays target disjoint files.
      const reclaudeSource = transformReclaudeServer(rawSource, filePath, { bundle: false });
      const nextSource =
        reclaudeSource === rawSource
          ? (translation.transformTranslationServerWithMap(rawSource, filePath)?.code ?? rawSource)
          : reclaudeSource;
      return nextSource === rawSource ? loaded : { ...loaded, source: nextSource };
    },
  });
}

module.exports = { register };
