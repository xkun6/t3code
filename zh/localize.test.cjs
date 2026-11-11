"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zh-localize-"));
process.env.T3CODE_ZH_ROOT = root;
process.env.T3CODE_LOCALE = "zh-Hans";

const { localize } = require("./localize.cjs");
const dictionary = new Map(
  Object.entries({
    "Hello world": "你好世界",
    Commit: "提交",
    Push: "推送",
    "Save changes": "保存更改",
    "Open {0} in {1}": "在 {1} 中打开 {0}",
    'Say "hi"': '说 "嗨"',
    Close: "关闭",
    Open: "打开",
    "Go back": "返回",
    "Failed to save": "保存失败",
  }),
);
require("./localize.cjs").__setDictionaryForTest(dictionary);

const file = path.join(root, "apps/web/src/Example.tsx");
const run = (code) => localize(code, file);

test("JSX text keeps surrounding whitespace and joins lines", () => {
  assert.equal(run("const a = <p>\n  Hello\n  world\n</p>;"), "const a = <p>\n  你好世界\n</p>;");
});

test("attributes, conditionals and children translate", () => {
  assert.equal(
    run('const a = <B title="Save changes" className="Save changes">{open ? "Close" : "Open"}</B>;'),
    'const a = <B title="保存更改" className="Save changes">{open ? "关闭" : "打开"}</B>;',
  );
});

test("attribute translations with quotes become expressions", () => {
  assert.equal(run("const a = <B label='Say \"hi\"' />;"), 'const a = <B label={"说 \\"嗨\\""} />;');
});

test("template literals reorder their expressions", () => {
  assert.equal(run("const x = { title: `Open ${file} in ${app}` };"), "const x = { title: `在 ${app} 中打开 ${file}` };");
});

test("comparisons with translated labels keep matching", () => {
  assert.equal(
    run('const items = [{ label: "Commit" }]; if (item.label === "Commit") icon(); switch (a.label) { case "Push": break; }'),
    'const items = [{ label: "提交" }]; if (item.label === "提交") icon(); switch (a.label) { case "推送": break; }',
  );
  assert.equal(
    run('const branchLabel = ref ?? "Push"; if (branchLabel === "Push") x(); if (detail === "Commit") y();'),
    'const branchLabel = ref ?? "推送"; if (branchLabel === "推送") x(); if (detail === "提交") y();',
  );
});

test("copy constants translate every string value", () => {
  assert.equal(
    run(
      'export const SECTION_LABELS = { "/settings/a": "Commit", nested: { b: "Push" } } as const;\n' +
        'const stepLabel = (t) => { if (t) return "Close"; return `Open ${t} in ${app}`; };\n' +
        'const SAVE_MESSAGE = "Failed to save"; function backTitle() { return "Go back"; }',
    ),
    'export const SECTION_LABELS = { "/settings/a": "提交", nested: { b: "推送" } } as const;\n' +
      'const stepLabel = (t) => { if (t) return "关闭"; return `在 ${app} 中打开 ${t}`; };\n' +
      'const SAVE_MESSAGE = "保存失败"; function backTitle() { return "返回"; }',
  );
});

test("arguments bound to copy-named parameters translate", () => {
  assert.equal(
    run(
      'const page = (target, icon, label) => ({ target, icon, label });\n' +
        'function settingsPage(title: string) { return { title }; }\n' +
        'const rows = [page("Push", "gear", "Commit"), settingsPage("Close")]; const d = <E detail="Go back" />;',
    ),
    'const page = (target, icon, label) => ({ target, icon, label });\n' +
      'function settingsPage(title: string) { return { title }; }\n' +
      'const rows = [page("Push", "gear", "提交"), settingsPage("关闭")]; const d = <E detail="返回" />;',
  );
});

test("lookup tables read in UI positions translate their values", () => {
  assert.equal(
    run(
      'const STATES = { open: "Open", closed: "Close" } as const;\n' +
        'const a = <Menu label={STATES[state]}>{MODES[m]}</Menu>; const MODES = { a: "Push" };',
    ),
    'const STATES = { open: "打开", closed: "关闭" } as const;\n' +
      'const a = <Menu label={STATES[state]}>{MODES[m]}</Menu>; const MODES = { a: "推送" };',
  );
});

test("per-file overrides win over the dictionary", () => {
  const { __setOverridesForTest } = require("./localize.cjs");
  __setOverridesForTest({ "apps/web/src/Example.tsx": { Commit: "Commit" } });
  assert.equal(run("const a = <b>Commit</b>;"), "const a = <b>Commit</b>;");
  __setOverridesForTest({});
  assert.equal(run("const a = <b>Commit</b>;"), "const a = <b>提交</b>;");
});

test("non-UI strings stay as they are", () => {
  const code =
    'const mode = "Commit"; fetch("Go back"); const k = { kind: "Push" };' +
    'const MODES = { a: "Close" }; send(MODES[m]); const b = <B label={props[k]} />;';
  assert.equal(run(code), code);
});

test("toast calls translate their message", () => {
  assert.equal(run('toast.error("Failed to save");'), 'toast.error("保存失败");');
});

test("files outside the UI directories are untouched", () => {
  const code = 'const a = { label: "Commit" };';
  assert.equal(localize(code, path.join(root, "apps/server/src/x.ts")), code);
});

test("JSX entities decode before lookup", () => {
  require("./localize.cjs").__setDictionaryForTest(new Map([["Don't stop", "别停"]]));
  assert.equal(run("const a = <p>Don&apos;t stop</p>;"), "const a = <p>别停</p>;");
  require("./localize.cjs").__setDictionaryForTest(dictionary);
});

test("plural suffix slots may be dropped, other slots may not", () => {
  const { checkTranslation } = require("./localize.cjs");
  assert.equal(checkTranslation("{0} favorite{1}", "{0} 个收藏"), null);
  assert.equal(checkTranslation("Open {0} in {1}", "打开 {0}"), "missing placeholder {1}");
  assert.equal(checkTranslation(" · {0} hidden", "· 已隐藏 {0}"), "leading or trailing whitespace changed");
  assert.equal(checkTranslation("Save", "保存 {2}"), "unknown placeholder {2}");
});
