// Build-time hook for the Windows tray (desktop-tray.mjs): hands the main window to the tray right
// before upstream registers its own "close" listener, without touching DesktopWindow.ts on disk.
"use strict";

const MagicString = require("magic-string").default;

const SPECIFIER = "t3code:zh-desktop-tray";
const TARGET_FILES = ["apps/desktop/src/window/DesktopWindow.ts"];
const ANCHOR = /^([ \t]*)window\.on\("close", /gm;
const ICON_ANCHOR = /^\s*const iconOption = getIconOption\(/m;
const I18N_FILE = "apps/desktop/src/i18n/messages.ts";
// Labels reuse source strings the desktop catalogs already translate (`$context` is part of the
// key), so the tray follows the UI language without strings of its own.
const LABEL_SOURCES = {
  show: ["Open", { $context: "button, opens a link in another app" }],
  quit: ["Quit {appName}"],
};
// Appended to desktop-tray.mjs, which vite-plugin.cjs serves from apps/desktop/src/__zh__/.
const WIRING = `import * as electron from "electron";
import { msg } from "gt-i18n";
import { m, onLocaleChange } from "../i18n/messages.ts";
export const attachZhTray = createZhTray({
  app: electron.app,
  Menu: electron.Menu,
  Tray: electron.Tray,
  onLocaleChange,
  labels: () => ({
    show: m(msg(${JSON.stringify(LABEL_SOURCES.show).slice(1, -1)})),
    quit: m(msg(${JSON.stringify(LABEL_SOURCES.quit).slice(1, -1)}), { appName: electron.app.getName() }),
  }),
});
`;

/** Returns `{ code, map, warnings }` for the target, or null for any other file. */
function transformDesktopTrayWithMap(code, file, options = {}) {
  const normalized = file.split("\\").join("/");
  const rel = TARGET_FILES.find((target) => normalized.endsWith(`/${target}`));
  if (!rel || code.includes(SPECIFIER)) return null;
  const matches = [...code.matchAll(ANCHOR)];
  if (matches.length !== 1) {
    if (!options.silent) console.warn(`::warning::desktop tray hook anchor not found in ${rel}`);
    return { code, map: null, warnings: [`${rel}#close`] };
  }
  // The main window's own icon (icon.ico on Windows), in scope in the same createWindow body.
  const hasIcon = ICON_ANCHOR.test(code);
  const warnings = hasIcon ? [] : [`${rel}#iconOption`];
  if (!hasIcon && !options.silent) console.warn(`::warning::desktop tray icon anchor not found in ${rel}`);
  const { index, 1: indent } = matches[0];
  const ms = new MagicString(code);
  ms.appendLeft(index, `${indent}__zhAttachTray(window${hasIcon ? ", iconOption.icon" : ""});\n`);
  ms.prepend(`import { attachZhTray as __zhAttachTray } from "${SPECIFIER}";\n`);
  return { code: ms.toString(), map: ms.generateMap({ hires: "boundary", source: file }), warnings };
}

module.exports = { I18N_FILE, LABEL_SOURCES, SPECIFIER, TARGET_FILES, WIRING, transformDesktopTrayWithMap };
