// Metro babel transformer that turns off telemetry and wires in conversation translation, then hands
// off to Expo's transformer.
"use strict";

const path = require("node:path");
const { transformTranslationMobileWithMap } = require("./translation-transform.cjs");
const { transformTelemetryWithMap } = require("./telemetry-transform.cjs");

const upstreamPath = process.env.T3CODE_ZH_UPSTREAM_TRANSFORMER;
if (!upstreamPath) throw new Error("T3CODE_ZH_UPSTREAM_TRANSFORMER is not set; see zh/metro.cjs.");
const upstream = require(upstreamPath);

module.exports = {
  ...upstream,
  transform(params) {
    // Metro passes filenames relative to the project root.
    const file = path.resolve(params.options.projectRoot, params.filename);
    const telemetry = transformTelemetryWithMap(params.src, file)?.code;
    if (telemetry) return upstream.transform({ ...params, src: telemetry });
    const src = transformTranslationMobileWithMap(params.src, file)?.code ?? params.src;
    return upstream.transform({ ...params, src });
  },
};
