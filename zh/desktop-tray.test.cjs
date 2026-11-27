"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { parseSync } = require("oxc-parser");

const { I18N_FILE, LABEL_SOURCES, TARGET_FILES, WIRING, transformDesktopTrayWithMap } = require("./desktop-tray-transform.cjs");

const ROOT = process.env.T3CODE_ZH_ROOT || path.resolve(__dirname, "..");
const target = path.join(ROOT, TARGET_FILES[0]);
const upstreamTest = fs.existsSync(target) ? test : test.skip;

upstreamTest("hands the upstream main window to the tray before its close listener", () => {
  const result = transformDesktopTrayWithMap(fs.readFileSync(target, "utf8"), target, { silent: true });
  assert.ok(result, "DesktopWindow.ts is a tray target");
  assert.deepEqual(result.warnings, []);
  assert.match(result.code, /__zhAttachTray\(window\);\n\s*window\.on\("close", /);
  assert.equal(parseSync(target, result.code, { lang: "ts", sourceType: "module" }).errors.length, 0);
});

upstreamTest("tray labels reuse strings the desktop catalogs translate", () => {
  const sources = fs
    .readdirSync(path.join(ROOT, "apps/desktop/src"), { recursive: true })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => fs.readFileSync(path.join(ROOT, "apps/desktop/src", file), "utf8").replace(/\s+/g, ""));
  for (const [source, options] of Object.values(LABEL_SOURCES)) {
    const call = (
      options
        ? `msg(${JSON.stringify(source)},{$context:${JSON.stringify(options.$context)}})`
        : `msg(${JSON.stringify(source)})`
    ).replace(/\s+/g, "");
    assert.ok(sources.some((code) => code.includes(call)), `no upstream ${call}`);
  }
  const i18n = fs.readFileSync(path.join(ROOT, I18N_FILE), "utf8");
  assert.match(i18n, /export function m\(/);
  assert.match(i18n, /export function onLocaleChange\(/);
  assert.equal(parseSync("tray.ts", WIRING, { lang: "ts", sourceType: "module" }).errors.length, 0);
});

test("leaves other files alone", () => {
  assert.equal(transformDesktopTrayWithMap('window.on("close", f);', "/x/apps/desktop/src/main.ts"), null);
});

function fakeElectron() {
  const app = new EventEmitter();
  app.getFileIcon = async () => "icon";
  app.getName = () => "T3 Code";
  app.quit = () => app.emit("before-quit");
  const trays = [];
  class Tray extends EventEmitter {
    constructor() {
      super();
      trays.push(this);
    }
    setToolTip() {}
    setContextMenu(menu) {
      this.menu = menu;
    }
  }
  const Menu = { buildFromTemplate: (items) => items };
  const locale = { current: "zh", listeners: [] };
  const labels = () => (locale.current === "zh" ? { show: "打开", quit: "退出 T3 Code" } : { show: "Open", quit: "Quit T3 Code" });
  const onLocaleChange = (listener) => locale.listeners.push(listener);
  const setLocale = (next) => {
    locale.current = next;
    for (const listener of locale.listeners) listener();
  };
  return { app, Menu, Tray, trays, labels, onLocaleChange, setLocale, platform: "win32" };
}

function fakeWindow() {
  const window = new EventEmitter();
  window.visible = true;
  window.hide = () => (window.visible = false);
  window.show = () => (window.visible = true);
  window.focus = () => {};
  window.restore = () => {};
  window.isMinimized = () => false;
  window.isDestroyed = () => false;
  window.close = () => {
    let prevented = false;
    window.emit("close", { preventDefault: () => (prevented = true) });
    return !prevented;
  };
  return window;
}

test("closing hides to the tray until the app quits", async () => {
  const { createZhTray } = await import("./desktop-tray.mjs");
  const electron = fakeElectron();
  const window = fakeWindow();
  createZhTray(electron)(window);
  await new Promise(setImmediate);

  assert.equal(window.close(), false);
  assert.equal(window.visible, false);
  electron.trays[0].emit("click");
  assert.equal(window.visible, true);

  electron.trays[0].menu.find((item) => item.label === "退出 T3 Code").click();
  assert.equal(window.close(), true);
});

test("the tray menu follows the UI language", async () => {
  const { createZhTray } = await import("./desktop-tray.mjs");
  const electron = fakeElectron();
  createZhTray(electron)(fakeWindow());
  await new Promise(setImmediate);
  assert.deepEqual(electron.trays[0].menu.map((item) => item.label), ["打开", undefined, "退出 T3 Code"]);
  electron.setLocale("en");
  assert.deepEqual(electron.trays[0].menu.map((item) => item.label), ["Open", undefined, "Quit T3 Code"]);
});

test("Windows session end lets the window close", async () => {
  const { createZhTray } = await import("./desktop-tray.mjs");
  const electron = fakeElectron();
  const window = fakeWindow();
  createZhTray(electron)(window);
  await new Promise(setImmediate);
  window.emit("query-session-end");
  assert.equal(window.close(), true);
});

test("does nothing outside Windows", async () => {
  const { createZhTray } = await import("./desktop-tray.mjs");
  const electron = { ...fakeElectron(), platform: "linux" };
  const window = fakeWindow();
  createZhTray(electron)(window);
  assert.equal(window.close(), true);
  assert.equal(electron.trays.length, 0);
});
