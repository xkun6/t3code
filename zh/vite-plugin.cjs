// Vite / Rolldown plugins:
// - zhLocalePlugin: turns off upstream telemetry and wires the conversation-translation UI into the
//   web app. The UI itself uses upstream's own zh catalog.
// - zhServerPlugin: wires Reclaude (`rec`) / Recodex (`recx`) support and conversation translation
//   into server bundles.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  RUNTIME_SPECIFIER,
  isReclaudeEnabled,
  transformReclaudeServerWithMap,
} = require("./reclaude-transform.cjs");
const translation = require("./translation-transform.cjs");
const { transformTelemetryWithMap } = require("./telemetry-transform.cjs");
const desktopTray = require("./desktop-tray-transform.cjs");

const VIRTUAL_RUNTIME_ID = `\0${RUNTIME_SPECIFIER}`;
const RUNTIME_FILE_PATH = path.join(__dirname, "reclaude-runtime.mjs");
const VIRTUAL_TRANSLATION_RUNTIME_ID = `\0${translation.RUNTIME_SPECIFIER}`;
const TRANSLATION_RUNTIME_FILE_PATH = path.join(__dirname, "translation-runtime.mjs");
const TRANSLATION_WEB_FILE_PATH = path.join(__dirname, "web", "translation.tsx");
const DESKTOP_TRAY_FILE_PATH = path.join(__dirname, "desktop-tray.mjs");
// Not a file on disk: the id sits inside the web app so the module's imports resolve from there.
const ROOT = (process.env.T3CODE_ZH_ROOT || path.resolve(__dirname, "..")).split(path.sep).join("/");
const TRANSLATION_WEB_ID = `${ROOT}/apps/web/src/__zh__/translation.tsx`;
// Same idea for the tray: its wiring imports the desktop i18n module and gt-i18n.
const DESKTOP_TRAY_ID = `${ROOT}/apps/desktop/src/__zh__/tray.ts`;

function zhLocalePlugin() {
  return {
    name: "t3code-zh-locale",
    enforce: "pre",
    resolveId(source) {
      if (source === translation.WEB_SPECIFIER) return TRANSLATION_WEB_ID;
      if (source === desktopTray.SPECIFIER) return DESKTOP_TRAY_ID;
      // The dev server asks again by URL (`/src/__zh__/translation.tsx`).
      const clean = source.split("?")[0].split("\\").join("/");
      return clean.endsWith("/__zh__/translation.tsx") ? TRANSLATION_WEB_ID : null;
    },
    load(id) {
      if (id.split("?")[0] === TRANSLATION_WEB_ID) return fs.readFileSync(TRANSLATION_WEB_FILE_PATH, "utf8");
      if (id.split("?")[0] === DESKTOP_TRAY_ID) {
        return `${fs.readFileSync(DESKTOP_TRAY_FILE_PATH, "utf8")}\n${desktopTray.WIRING}`;
      }
      return null;
    },
    transform(code, id) {
      const file = id.split("?")[0];
      // Telemetry targets are disjoint from the translation and tray targets.
      const telemetry = transformTelemetryWithMap(code, file);
      if (telemetry) return telemetry;
      const tray = desktopTray.transformDesktopTrayWithMap(code, file);
      if (tray) return tray.map ? { code: tray.code, map: tray.map } : null;
      const translated = translation.transformTranslationWebWithMap(code, file);
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
      // The overlays target disjoint files.
      const result =
        transformTelemetryWithMap(code, file) ??
        (isReclaudeEnabled() ? transformReclaudeServerWithMap(code, file, { bundle: true }) : null) ??
        translation.transformTranslationServerWithMap(code, file);
      return result?.map ? { code: result.code, map: result.map } : null;
    },
  };
}

module.exports = { zhLocalePlugin, zhServerPlugin };
