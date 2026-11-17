// Metro babel transformer that wires in conversation translation and localizes UI sources, then
// hands off to Expo's transformer.
"use strict";

const path = require("node:path");
const { localize } = require("./localize.cjs");
const { transformTranslationMobileWithMap } = require("./translation-transform.cjs");

const upstreamPath = process.env.T3CODE_ZH_UPSTREAM_TRANSFORMER;
if (!upstreamPath) throw new Error("T3CODE_ZH_UPSTREAM_TRANSFORMER is not set; see zh/metro.cjs.");
const upstream = require(upstreamPath);

module.exports = {
  ...upstream,
  transform(params) {
    // Metro passes filenames relative to the project root.
    const file = path.resolve(params.options.projectRoot, params.filename);
    const src = transformTranslationMobileWithMap(params.src, file)?.code ?? params.src;
    return upstream.transform({ ...params, src: localize(src, file) });
  },
};
