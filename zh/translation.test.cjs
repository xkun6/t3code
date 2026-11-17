"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseSync } = require("oxc-parser");

const transform = require("./translation-transform.cjs");

const runtimeModule = import("./translation-runtime.mjs");

function findUpstreamCheckout() {
  const candidates = [
    process.env.T3CODE_ZH_ROOT,
    path.resolve(__dirname, ".."),
    path.resolve(__dirname, "../../../.."),
  ].filter(Boolean);
  return candidates.find((dir) => fs.existsSync(path.join(dir, "apps/server/src/ws.ts"))) ?? null;
}

const upstream = findUpstreamCheckout();
const upstreamTest = upstream ? test : test.skip;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zh-translation-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A chat-completions endpoint whose "translation" is `translateText(original)`. */
function fakeEndpoint(translateText = (text) => `EN(${text})`) {
  const requests = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, headers: init.headers, body });
    const user = body.messages.at(-1).content;
    const inner = user.slice("<translate-input>\n".length, -"\n</translate-input>".length);
    const content = inner.startsWith("<ti n=")
      ? inner.replace(/(<ti n="[^"]+" i="\d+">)\n([\s\S]*?)\n(<\/ti n="[^"]+" i="\d+">)/g, (_, open, text, close) =>
          `${open}\n${translateText(text)}\n${close}`,
        )
      : translateText(inner);
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
  };
  return { requests, fetchFn };
}

const CONFIGURED = { baseUrl: "https://llm.test/v1", model: "m", apiKey: "sk-secret" };
const ADMIN = ["orchestration:operate", "settings:write"];

async function configuredService(t, endpoint, patch = {}) {
  const { createTranslationService } = await runtimeModule;
  const dir = tempDir(t);
  const service = createTranslationService({ dir, fetchFn: endpoint.fetchFn, warn: () => {} });
  const saved = await service.handleRpc({ op: "setConfig", input: { patch: { ...CONFIGURED, ...patch } } }, ADMIN);
  assert.equal(saved.ok, true);
  return { service, dir };
}

const userMessage = (overrides = {}) => ({
  id: "message-1",
  threadId: "thread-1",
  role: "user",
  text: "你好",
  createdBy: "user",
  creationSource: "web",
  ...overrides,
});

test("promptTranslationParts keeps a slash command word and skips what has nothing to translate", async () => {
  const { promptTranslationParts } = await runtimeModule;
  assert.deepEqual(promptTranslationParts("修复这个问题"), { prefix: "", body: "修复这个问题" });
  assert.deepEqual(promptTranslationParts("/goal  修复登录"), { prefix: "/goal  ", body: "修复登录" });
  assert.equal(promptTranslationParts("/compact"), null);
  assert.equal(promptTranslationParts("  \n"), null);
});

test("batch items round-trip by index and reject missing or empty items", async () => {
  const { wrapTranslationBatch, parseTranslationBatch, packTranslationBatches } = await runtimeModule;
  const wrapped = wrapTranslationBatch(["a </ti> b", "second"], "nonce");
  const inner = wrapped.slice("<translate-input>\n".length, -"\n</translate-input>".length);
  assert.deepEqual(parseTranslationBatch(`noise\n${inner}\ntrailing`, 2, "nonce"), ["a </ti> b", "second"]);
  assert.equal(parseTranslationBatch(inner, 3, "nonce"), null);
  assert.equal(parseTranslationBatch('<ti n="nonce" i="0">\n\n</ti n="nonce" i="0">', 1, "nonce"), null);

  const packs = packTranslationBatches([{ text: "aaaa" }, { text: "bbbb" }, { text: "cc" }], 2, 6);
  assert.deepEqual(packs.map((pack) => pack.map((item) => item.text)), [["aaaa"], ["bbbb", "cc"]]);
});

test("completeChat speaks all three protocols and reports truncation and HTTP errors", async () => {
  const { completeChat } = await runtimeModule;
  const calls = [];
  const reply = (body, status = 200) => async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status });
  };
  const base = { baseUrl: "https://llm.test/v1/", model: "m", apiKey: "sk" };

  assert.equal(
    await completeChat(
      { ...base, protocol: "chat-completions" },
      "sys",
      "user",
      reply({ choices: [{ message: { content: "ok" } }] }),
    ),
    "ok",
  );
  assert.equal(calls[0].url, "https://llm.test/v1/chat/completions");
  assert.equal(calls[0].headers.authorization, "Bearer sk");
  assert.deepEqual(calls[0].body.messages.map((message) => message.role), ["system", "user"]);

  assert.equal(
    await completeChat(
      { ...base, protocol: "responses" },
      "sys",
      "user",
      reply({ output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "ok" }] }] }),
    ),
    "ok",
  );
  assert.equal(calls[1].url, "https://llm.test/v1/responses");
  assert.equal(calls[1].body.instructions, "sys");
  assert.equal(calls[1].body.store, false);

  assert.equal(
    await completeChat(
      { ...base, baseUrl: "https://llm.test/anthropic", protocol: "anthropic" },
      "sys",
      "user",
      reply({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
    ),
    "ok",
  );
  assert.equal(calls[2].url, "https://llm.test/anthropic/v1/messages");
  assert.equal(calls[2].headers["x-api-key"], "sk");
  assert.equal(calls[2].body.system, "sys");

  await assert.rejects(
    completeChat(
      { ...base, protocol: "anthropic" },
      "sys",
      "user",
      reply({ content: [{ type: "text", text: "half" }], stop_reason: "max_tokens" }),
    ),
    /截断/,
  );
  await assert.rejects(
    completeChat({ ...base, protocol: "chat-completions" }, "sys", "user", reply({ error: "bad key" }, 401)),
    /HTTP 401.*bad key/,
  );
});

test("translate caches results, batches concurrent requests, and survives a restart from disk", async (t) => {
  const { createTranslationService } = await runtimeModule;
  const endpoint = fakeEndpoint();
  const { service, dir } = await configuredService(t, endpoint);

  const texts = ["一", "二", "三"];
  const translated = await Promise.all(texts.map((text) => service.translate("user-to-agent", text)));
  assert.deepEqual(translated, ["EN(一)", "EN(二)", "EN(三)"]);
  assert.equal(endpoint.requests.length, 1, "three concurrent texts share one request");
  assert.match(endpoint.requests[0].body.messages[0].content, /from 简体中文 to English/);

  assert.equal(await service.translate("user-to-agent", "一"), "EN(一)");
  assert.equal(endpoint.requests.length, 1, "a repeat is served from the cache");
  // The other direction is a different translation of the same text.
  await service.translate("agent-to-user", "one");
  assert.equal(endpoint.requests.length, 2);
  assert.match(endpoint.requests[1].body.messages[0].content, /from English to 简体中文/);

  const restarted = createTranslationService({ dir, fetchFn: endpoint.fetchFn, warn: () => {} });
  assert.equal(await restarted.translate("user-to-agent", "二"), "EN(二)");
  assert.equal(endpoint.requests.length, 2, "config and cache are read back from disk");
});

test("a batch the model garbles falls back to one request per text", async (t) => {
  let requests = 0;
  const single = fakeEndpoint();
  const endpoint = {
    fetchFn: async (url, init) => {
      requests += 1;
      const user = JSON.parse(init.body).messages.at(-1).content;
      if (user.includes("<ti n=")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "sorry, no tags" } }] }));
      }
      return single.fetchFn(url, init);
    },
  };
  const { service } = await configuredService(t, endpoint);
  assert.deepEqual(
    await Promise.all(["一", "二"].map((text) => service.translate("user-to-agent", text))),
    ["EN(一)", "EN(二)"],
  );
  assert.equal(requests, 3);
});

test("the RPC guards settings, hides the API key, and reports failures in the envelope", async (t) => {
  const { createTranslationService } = await runtimeModule;
  const endpoint = fakeEndpoint();
  const service = createTranslationService({ dir: tempDir(t), fetchFn: endpoint.fetchFn, warn: () => {} });

  const unconfigured = await service.handleRpc({ op: "translate", input: { direction: "agent-to-user", text: "hi" } });
  assert.equal(unconfigured.ok, false);
  assert.match(unconfigured.error, /未配置/);

  const refused = await service.handleRpc({ op: "setConfig", input: { patch: CONFIGURED } }, ["orchestration:operate"]);
  assert.deepEqual(refused, { ok: false, error: "当前连接没有修改设置的权限" });
  const invalid = await service.handleRpc({ op: "setConfig", input: { patch: { protocol: "soap" } } }, ADMIN);
  assert.equal(invalid.ok, false);

  const saved = await service.handleRpc(
    { op: "setConfig", input: { threadId: "thread-1", patch: { ...CONFIGURED, protocol: "anthropic" } } },
    ADMIN,
  );
  assert.equal(saved.ok, true);
  assert.equal(JSON.stringify(saved).includes("sk-secret"), false);
  assert.equal(saved.value.configured, true);
  assert.equal(saved.value.config.apiKeySet, true);
  assert.equal(saved.value.config.requestUrl, "https://llm.test/v1/v1/messages");

  // A thread follows the default until it is switched explicitly.
  assert.equal(saved.value.threadEnabled, false);
  await service.handleRpc({ op: "setConfig", input: { patch: { enabledByDefault: true } } }, ADMIN);
  assert.equal((await service.handleRpc({ op: "state", input: { threadId: "thread-1" } })).value.threadEnabled, true);
  await service.handleRpc({ op: "setThread", input: { threadId: "thread-1", enabled: false } });
  assert.equal((await service.handleRpc({ op: "state", input: { threadId: "thread-1" } })).value.threadEnabled, false);
  assert.equal((await service.handleRpc({ op: "state", input: { threadId: "thread-2" } })).value.threadEnabled, true);
});

test("translateUserMessage translates only what a person typed in an enabled thread", async (t) => {
  const endpoint = fakeEndpoint();
  const { service } = await configuredService(t, endpoint);

  assert.equal(await service.translateUserMessage(userMessage()), "你好", "the thread is not enabled yet");
  await service.handleRpc({ op: "setThread", input: { threadId: "thread-1", enabled: true } });
  assert.equal(await service.translateUserMessage(userMessage()), "EN(你好)");
  assert.deepEqual((await service.handleRpc({ op: "sent", input: { messageId: "message-1" } })).value, {
    text: "EN(你好)",
  });

  assert.equal(
    await service.translateUserMessage(userMessage({ id: "m-goal", text: "/goal 修复登录" })),
    "/goal EN(修复登录)",
  );
  assert.equal(await service.translateUserMessage(userMessage({ id: "m-compact", text: "/compact" })), "/compact");

  for (const overrides of [
    { createdBy: "agent" },
    { creationSource: "mcp" },
    { creationSource: "server" },
    { scheduledTaskId: "task-1" },
    { senderThreadId: "thread-9" },
    { context: { guest: { name: "g" } } },
    { threadId: "thread-other" },
  ]) {
    const message = userMessage({ id: "m-skip", text: "不要翻译", ...overrides });
    assert.equal(await service.translateUserMessage(message), "不要翻译", JSON.stringify(overrides));
  }
  assert.equal((await service.handleRpc({ op: "sent", input: { messageId: "m-skip" } })).value, null);

  await service.handleRpc({ op: "setConfig", input: { patch: { translateInput: false } } }, ADMIN);
  assert.equal(await service.translateUserMessage(userMessage({ id: "m-off", text: "关掉了" })), "关掉了");
});

test("translateUserMessage sends the original when the endpoint fails or drops an attachment link", async (t) => {
  const link = "[图片](t3-context:image/abc)";
  const endpoint = fakeEndpoint((text) => {
    if (text.includes("炸了")) throw new Error("endpoint down");
    return text.replace(link, "the image");
  });
  const { service } = await configuredService(t, endpoint, { enabledByDefault: true });

  const withLink = userMessage({ id: "m-link", text: `看这张 ${link}` });
  assert.equal(await service.translateUserMessage(withLink), withLink.text);
  assert.match((await service.handleRpc({ op: "sent", input: { messageId: "m-link" } })).value.error, /附件引用/);

  const failing = userMessage({ id: "m-fail", text: "炸了" });
  assert.equal(await service.translateUserMessage(failing), "炸了");
  assert.match((await service.handleRpc({ op: "sent", input: { messageId: "m-fail" } })).value.error, /endpoint down/);
});

test("text whose writing system shows it needs no translation never reaches the endpoint", async (t) => {
  const { needsTranslation } = await runtimeModule;
  for (const [text, source, target, expected] of [
    ["The tests pass now.", "English", "简体中文", true],
    ["测试已经通过了。", "English", "简体中文", false],
    ["我修改了 ProviderTurnStartService 里的 translateUserMessage 调用，测试通过。", "English", "简体中文", false],
    ["Fixed. The user wrote 你好 in the prompt and the parser now accepts it without errors.", "English", "简体中文", true],
    ["テストは通りました。", "English", "简体中文", true],
    ["テストは通りました。", "English", "日本語", false],
    ["测试通过", "English", "日本語", true],
    ["```ts\nconst a = 1;\n```", "English", "简体中文", false],
    ["src/login.ts", "简体中文", "English", false],
    ["fix the login bug", "简体中文", "English", false],
    ["修复登录问题", "简体中文", "English", true],
    ["Bonjour le monde", "Français", "English", true],
    ["Тесты проходят", "English", "Русский", false],
  ]) {
    assert.equal(needsTranslation(text, source, target), expected, `${text} (${source} -> ${target})`);
  }

  const endpoint = fakeEndpoint();
  const { service } = await configuredService(t, endpoint);
  assert.equal(await service.translate("agent-to-user", "已经是中文了。"), "已经是中文了。");
  assert.equal(await service.translate("user-to-agent", "already English"), "already English");
  assert.equal(endpoint.requests.length, 0);
  // The settings test must reach the endpoint whatever the sample looks like.
  const tested = await service.handleRpc({
    op: "translate",
    input: { direction: "user-to-agent", text: "already English", fresh: true },
  });
  assert.deepEqual(tested, { ok: true, value: { text: "EN(already English)" } });
});

test("request answers keep offered options exact and translate only what the user typed", async (t) => {
  const endpoint = fakeEndpoint((text) => {
    if (text.includes("炸了")) throw new Error("endpoint down");
    return `EN(${text})`;
  });
  const { service } = await configuredService(t, endpoint);
  const questions = [
    { id: "q-env", options: [{ label: "Staging", description: "" }, { label: "Prod", description: "", value: "prod " }] },
    { id: "q-tags", multiSelect: true, options: [{ label: "Fast", description: "" }] },
    { id: "q-name", options: [] },
  ];
  const answers = { "q-env": "prod ", "q-tags": ["Fast", "要稳定"], "q-name": "登录模块", "q-unknown": "不认识的题" };
  const context = { threadId: "thread-1", questions };

  assert.deepEqual(await service.translateAnswers(answers, context), answers, "the thread is not enabled yet");
  assert.equal(await service.translateFeedback("先别动数据库", context), "先别动数据库");
  await service.handleRpc({ op: "setThread", input: { threadId: "thread-1", enabled: true } });

  assert.deepEqual(await service.translateAnswers(answers, context), {
    "q-env": "prod ",
    "q-tags": ["Fast", "EN(要稳定)"],
    "q-name": "EN(登录模块)",
    "q-unknown": "不认识的题",
  });
  assert.deepEqual(await service.translateAnswers({ "q-env": " Staging " }, context), { "q-env": " Staging " });
  // Without the questions an option cannot be told from typed text, so nothing is touched.
  assert.deepEqual(await service.translateAnswers(answers, { threadId: "thread-1" }), answers);
  assert.equal(await service.translateFeedback("先别动数据库", context), "EN(先别动数据库)");
  assert.equal(await service.translateFeedback(undefined, context), undefined);
  assert.deepEqual(await service.translateAnswers({ "q-name": "炸了" }, context), { "q-name": "炸了" });

  // A question answered after its turn ended reaches the provider as a server-composed message.
  const late = userMessage({ id: "async-answer:request-1", creationSource: "server", text: "Which env?\n测试环境" });
  assert.equal(await service.translateUserMessage(late), "EN(Which env?\n测试环境)");
});

upstreamTest("every upstream target transforms with zero missing anchors and a valid AST", () => {
  const groups = [
    [transform.SERVER_TARGET_FILES, transform.transformTranslationServerWithMap, "__zhTranslation."],
    [transform.WEB_TARGET_FILES, transform.transformTranslationWebWithMap, "__zhT."],
    [transform.MOBILE_TARGET_FILES, transform.transformTranslationMobileWithMap, "__zhT."],
  ];
  for (const [files, apply, binding] of groups) {
    for (const rel of files) {
      const file = path.join(upstream, rel);
      const code = fs.readFileSync(file, "utf8");
      const result = apply(code, file, { root: upstream, silent: true });
      assert.deepEqual(result.warnings, [], rel);
      assert.notEqual(result.code, code, rel);
      const parsed = parseSync(file, result.code, { lang: rel.endsWith(".tsx") ? "tsx" : "ts", sourceType: "module" });
      assert.equal(parsed.errors.length, 0, `${rel}: ${parsed.errors[0]?.message}`);
      assert.equal(/^import \* as __zh/m.test(result.code), result.code.includes(binding), `${rel}: import matches use`);
      assert.equal(apply(result.code, file, { root: upstream, silent: true }), null, `${rel}: idempotent`);
    }
  }
  const startService = "apps/server/src/orchestration-v2/ProviderTurnStartService.ts";
  const started = transform.transformTranslationServerWithMap(
    fs.readFileSync(path.join(upstream, startService), "utf8"),
    path.join(upstream, startService),
    { root: upstream, silent: true },
  ).code;
  // Only the text handed to the provider is translated; the slash-command probe keeps the original.
  assert.equal(started.match(/__zhTranslation\.translateUserMessage\((?:message|providerMessage),/g)?.length, 1);
  assert.equal(started.match(/text: (?:message|providerMessage)\.text,/g)?.length, 1);

  // The answer hook reads the request's questions through names the transform cannot check itself.
  const read = (rel) => fs.readFileSync(path.join(upstream, rel), "utf8");
  assert.ok(read("apps/server/src/orchestration-v2/ProjectionStore.ts").includes("readonly getRuntimeResponseContext: ("));
  assert.ok(
    read("packages/contracts/src/orchestrationV2.ts").includes("questions: Schema.Array(OrchestrationV2UserInputQuestion)"),
  );
  assert.ok(read("apps/server/src/orchestration-v2/Orchestrator.ts").includes("MessageId.make(`async-answer:${command.requestId}`)"));

  const panel = "apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx";
  const question = transform.transformTranslationWebWithMap(read(panel), path.join(upstream, panel), {
    root: upstream,
    silent: true,
  }).code;
  assert.equal(question.split("<__zhT.QuestionText ").length - 1, 5);
  // Answers are still built from the original option, never from what is displayed.
  assert.ok(question.includes("const optionValue = option.value ?? option.label;"));

  const mobileCard = "apps/mobile/src/features/threads/PendingUserInputCard.tsx";
  const mobileQuestion = transform.transformTranslationMobileWithMap(read(mobileCard), path.join(upstream, mobileCard), {
    root: upstream,
    silent: true,
  }).code;
  assert.equal(mobileQuestion.split("<__zhT.QuestionText ").length - 1, 3);
  assert.equal(mobileQuestion.split("__zhT.useAgentText(props.markdown").length - 1, 1);
  assert.ok(mobileQuestion.includes("const optionValue = option.value ?? option.label.trim();"));
});

upstreamTest("T3CODE_TRANSLATION=0 leaves every target untouched", (t) => {
  process.env.T3CODE_TRANSLATION = "0";
  t.after(() => delete process.env.T3CODE_TRANSLATION);
  const file = path.join(upstream, "apps/server/src/ws.ts");
  assert.equal(transform.transformTranslationServerWithMap(fs.readFileSync(file, "utf8"), file, { root: upstream }), null);
});

test("the RPC method name agrees across the transform, the runtime, and the client modules", async () => {
  const { RPC_METHOD } = await runtimeModule;
  assert.equal(RPC_METHOD, transform.RPC_METHOD);
  for (const client of ["web", "mobile"]) {
    const source = fs.readFileSync(path.join(__dirname, client, "translation.tsx"), "utf8");
    assert.ok(source.includes(`const RPC_METHOD = ${JSON.stringify(transform.RPC_METHOD)};`), client);
  }
});

test("Metro serves the mobile module and resolves its imports from inside the app", (t) => {
  const { withZhLocale, MOBILE_MODULE_PATH } = require("./metro.cjs");
  const previousTransformer = process.env.T3CODE_ZH_UPSTREAM_TRANSFORMER;
  t.after(() => {
    if (previousTransformer === undefined) delete process.env.T3CODE_ZH_UPSTREAM_TRANSFORMER;
    else process.env.T3CODE_ZH_UPSTREAM_TRANSFORMER = previousTransformer;
  });
  const projectRoot = path.join(os.tmpdir(), "app");
  const seen = [];
  const config = withZhLocale({
    projectRoot,
    transformer: { babelTransformerPath: "/upstream-transformer.js" },
    resolver: { resolveRequest: (context, moduleName) => (seen.push([context.originModulePath, moduleName]), { type: "empty" }) },
  });
  const resolve = (originModulePath, moduleName) => config.resolver.resolveRequest({ originModulePath }, moduleName, "ios");

  assert.deepEqual(resolve("/x.tsx", transform.MOBILE_SPECIFIER), { type: "sourceFile", filePath: MOBILE_MODULE_PATH });
  resolve(MOBILE_MODULE_PATH, "../connection/runtime");
  resolve("/elsewhere.tsx", "react-native");
  assert.deepEqual(seen, [
    [path.join(projectRoot, "src", "__zh__", "translation.tsx"), "../connection/runtime"],
    ["/elsewhere.tsx", "react-native"],
  ]);
});

upstreamTest("the mobile module only uses classes and imports that exist upstream", () => {
  const mobile = fs.readFileSync(path.join(__dirname, "mobile", "translation.tsx"), "utf8");
  const mobileRoot = path.join(upstream, "apps/mobile/src");
  const sources = [];
  for (const entry of fs.readdirSync(mobileRoot, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      sources.push(fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"));
    }
  }
  const haystack = sources.join("\n");
  // Uniwind generates classes it finds under apps/mobile only.
  const classNames = new Set();
  for (const match of mobile.matchAll(/"([a-z][\w ./:-]*)"/g)) {
    if (!/\btext-/.test(match[1])) continue;
    for (const name of match[1].split(/\s+/)) classNames.add(name);
  }
  assert.ok(classNames.has("text-foreground-muted"), "class extraction still finds the module's classes");
  const classBoundary = (name) => new RegExp(`(?<![\\w:/-])${name.replace(/[.\\/]/g, "\\$&")}(?![\\w:/.-])`);
  assert.deepEqual([...classNames].filter((name) => !classBoundary(name).test(haystack)), []);

  // Metro resolves the module's relative imports from apps/mobile/src/__zh__/.
  for (const match of mobile.matchAll(/import \{([^}]+)\} from "(\.\.\/[^"]+)";/g)) {
    const target = path.join(mobileRoot, "__zh__", match[2]);
    const file = [".tsx", ".ts"].map((extension) => target + extension).find((candidate) => fs.existsSync(candidate));
    assert.ok(file, `missing upstream module ${match[2]}`);
    const source = fs.readFileSync(file, "utf8");
    for (const name of match[1].split(",").map((part) => part.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
      assert.match(source, new RegExp(`export (?:const|function) ${name}\\b`), `${match[2]} no longer exports ${name}`);
    }
  }
});

upstreamTest("the web module only uses classes, imports, and scopes that exist upstream", () => {
  const web = fs.readFileSync(path.join(__dirname, "web", "translation.tsx"), "utf8");
  const webRoot = path.join(upstream, "apps/web/src");

  // Tailwind scans files under apps/web only, so a class this module introduces would have no CSS.
  const sources = [];
  for (const entry of fs.readdirSync(webRoot, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      sources.push(fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"));
    }
  }
  const haystack = sources.join("\n");
  const classNames = new Set();
  for (const match of web.matchAll(/(?:className=|_CLASS = )"([^"]+)"/g)) {
    for (const name of match[1].split(/\s+/)) if (/^[a-z][\w:./-]*$/.test(name)) classNames.add(name);
  }
  assert.ok(classNames.has("text-muted-foreground"), "class extraction still finds the module's classes");
  const classBoundary = (name) => new RegExp(`(?<![\\w:/-])${name.replace(/[.\\/]/g, "\\$&")}(?![\\w:/.-])`);
  const unknown = [...classNames].filter((name) => !classBoundary(name).test(haystack));
  assert.deepEqual(unknown, []);

  // The module is served from apps/web/src/__zh__/, so its relative imports resolve from there.
  for (const match of web.matchAll(/import \{([^}]+)\} from "(\.\.\/[^"]+)";/g)) {
    const target = path.join(webRoot, "__zh__", match[2]);
    const file = [".tsx", ".ts"].map((extension) => target + extension).find((candidate) => fs.existsSync(candidate));
    assert.ok(file, `missing upstream module ${match[2]}`);
    const source = fs.readFileSync(file, "utf8");
    for (const name of match[1].split(",").map((part) => part.trim()).filter(Boolean)) {
      assert.match(source, new RegExp(`\\b${name}\\b`), `${match[2]} no longer has ${name}`);
    }
  }

  const auth = fs.readFileSync(path.join(upstream, "packages/contracts/src/auth.ts"), "utf8");
  assert.match(auth, /AuthSettingsWriteScope = "settings:write"/);
});
