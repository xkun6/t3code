// Node module loader hook for unbundled `vp run dev` (`node --watch src/bin.ts`),
// applying the exact same Reclaude / Recodex AST transforms used by `zhServerPlugin` in `vp pack`.
"use strict";

const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");
const {
  RUNTIME_SPECIFIER,
  isReclaudeEnabled,
  transformReclaudeServer,
} = require("./reclaude-transform.cjs");

const RUNTIME_URL = pathToFileURL(path.join(__dirname, "reclaude-runtime.mjs")).href;
let registered = false;

function register(nodeModule) {
  if (registered || !isReclaudeEnabled() || typeof nodeModule?.registerHooks !== "function") {
    return;
  }
  registered = true;
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === RUNTIME_SPECIFIER) {
        return { url: RUNTIME_URL, shortCircuit: true };
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
      const nextSource = transformReclaudeServer(rawSource, filePath, { bundle: false });
      return nextSource === rawSource ? loaded : { ...loaded, source: nextSource };
    },
  });
}

module.exports = { register };
