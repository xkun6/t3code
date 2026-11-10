// Metro babel transformer that localizes UI sources, then hands off to Expo's transformer.
"use strict";

const path = require("node:path");
const { localize } = require("./localize.cjs");

const upstreamPath = process.env.T3CODE_ZH_UPSTREAM_TRANSFORMER;
if (!upstreamPath) throw new Error("T3CODE_ZH_UPSTREAM_TRANSFORMER is not set; see zh/metro.cjs.");
const upstream = require(upstreamPath);

module.exports = {
  ...upstream,
  transform(params) {
    // Metro passes filenames relative to the project root.
    const file = path.resolve(params.options.projectRoot, params.filename);
    return upstream.transform({ ...params, src: localize(params.src, file) });
  },
};
