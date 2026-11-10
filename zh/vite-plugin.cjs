// Vite / Rolldown plugin: localizes UI sources before React and the compiler see them.
"use strict";

const { localizeWithMap, isEnabled } = require("./localize.cjs");

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

module.exports = { zhLocalePlugin };
