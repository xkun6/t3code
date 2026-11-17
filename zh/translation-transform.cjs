// Build-time & dev-time AST transforms that wire conversation translation into T3 Code without
// touching upstream source files on disk:
// - server: one RPC (contract, authorization scope, handler) and translation of the user's own
//   text right before it reaches a provider adapter (turn start, steering, and request answers);
// - web: translated assistant replies, plan cards, and pending questions, the composer toggle, and
//   the "sent translation" disclosure;
// - mobile: the same translated replies, plans, and questions, and a per-thread composer switch.
"use strict";

const path = require("node:path");
const { parseSync } = require("oxc-parser");
const MagicString = require("magic-string").default;

const RUNTIME_SPECIFIER = "t3code:zh-translation-runtime";
const WEB_SPECIFIER = "t3code:zh-translation-web";
const MOBILE_SPECIFIER = "t3code:zh-translation-mobile";
// Must match RPC_METHOD in translation-runtime.mjs, web/translation.tsx, and mobile/translation.tsx.
const RPC_METHOD = "server.zhTranslation";
const RPC_CONST = "WsServerZhTranslationRpc";

function isTranslationEnabled() {
  return process.env.T3CODE_TRANSLATION !== "0";
}

function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== "object") return;
  visit(node, ancestors);
  ancestors.push(node);
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) if (item && typeof item.type === "string") walk(item, visit, ancestors);
    } else if (child && typeof child.type === "string") {
      walk(child, visit, ancestors);
    }
  }
  ancestors.pop();
}

/** Matches as `{ node, ancestors }`, ancestors outermost first. */
function find(root, predicate) {
  const matches = [];
  walk(root, (node, ancestors) => {
    if (predicate(node, ancestors)) matches.push({ node, ancestors: [...ancestors] });
  });
  return matches;
}

function calleeName(callee, code) {
  return callee ? code.slice(callee.start, callee.end).replace(/\s+/g, "") : "";
}

function declarator(root, name) {
  return find(root, (n) => n.type === "VariableDeclarator" && n.id?.type === "Identifier" && n.id.name === name)[0];
}

/** Strips `as const`, `satisfies T`, and parentheses. */
function unwrap(node) {
  let current = node;
  while (
    current &&
    (current.type === "TSSatisfiesExpression" ||
      current.type === "TSAsExpression" ||
      current.type === "ParenthesizedExpression")
  ) {
    current = current.expression;
  }
  return current;
}

function inGenerator(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const type = ancestors[index].type;
    if (type === "FunctionExpression" || type === "FunctionDeclaration") return ancestors[index].generator === true;
    if (type === "ArrowFunctionExpression") return false;
  }
  return false;
}

function jsxName(element) {
  const name = element.openingElement?.name;
  return name?.type === "JSXIdentifier" ? name.name : "";
}

function jsxAttribute(element, name) {
  return element.openingElement.attributes.find(
    (attribute) => attribute.type === "JSXAttribute" && attribute.name?.name === name,
  );
}

function jsxAttributeSource(element, name, code) {
  const expression = jsxAttribute(element, name)?.value?.expression;
  return expression ? code.slice(expression.start, expression.end).replace(/\s+/g, "") : "";
}

/**
 * The `text: message.text` property of a `projectComposerContextForProvider({ ... })` call. Newer
 * upstream names it `providerMessage`, since a resumed run may send an earlier message.
 */
function composerContextTextProperty(call, code) {
  if (call?.type !== "CallExpression" || calleeName(call.callee, code) !== "projectComposerContextForProvider") {
    return null;
  }
  const argument = call.arguments?.[0];
  if (argument?.type !== "ObjectExpression") return null;
  const property = argument.properties.find(
    (candidate) =>
      candidate.key?.type === "Identifier" &&
      candidate.key.name === "text" &&
      /^(?:message|providerMessage)\.text$/.test(code.slice(candidate.value.start, candidate.value.end)),
  );
  return property ?? null;
}

/** Declares the RPC and adds it to WsRpcGroup. Applied to both the server and the web bundle. */
function transformContracts(code, ast, ms, warn) {
  const group = declarator(ast, "WsRpcGroup");
  const make = group
    ? find(
        group.node,
        (n) => n.type === "CallExpression" && calleeName(n.callee, code) === "RpcGroup.make" && n.arguments.length > 0,
      )[0]
    : undefined;
  const statement = group ? ast.body.find((node) => node.start <= group.node.start && node.end >= group.node.end) : undefined;
  if (!make || !statement || !/\bEnvironmentAuthorizationError\b/.test(code)) {
    warn("WsRpcGroup");
    return 0;
  }
  ms.appendLeft(
    statement.start,
    `const ${RPC_CONST} = Rpc.make(${JSON.stringify(RPC_METHOD)}, {\n  payload: Schema.Struct({ op: Schema.String, input: Schema.Unknown }),\n  success: Schema.Unknown,\n  error: EnvironmentAuthorizationError,\n});\n\n`,
  );
  ms.appendRight(make.node.arguments.at(-1).end, `, ${RPC_CONST}`);
  return 1;
}

const SERVER_TRANSFORMERS = {
  "packages/contracts/src/rpc.ts": transformContracts,

  "apps/server/src/auth/RpcAuthorization.ts"(code, ast, ms, warn) {
    const scopes = unwrap(declarator(ast, "RPC_REQUIRED_SCOPES")?.node.init);
    if (scopes?.type !== "ObjectExpression" || scopes.properties.length === 0 || !/\bAuthOrchestrationOperateScope\b/.test(code)) {
      warn("RPC_REQUIRED_SCOPES");
      return 0;
    }
    // Translating spends the configured API key, so it needs more than read access.
    ms.appendRight(scopes.properties.at(-1).end, `, [${JSON.stringify(RPC_METHOD)}]: AuthOrchestrationOperateScope`);
    return 1;
  },

  "apps/server/src/ws.ts"(code, ast, ms, warn) {
    const handlers = find(
      ast,
      (n) =>
        n.type === "CallExpression" &&
        calleeName(n.callee, code) === "ServerWsRpcGroup.of" &&
        n.arguments?.[0]?.type === "ObjectExpression" &&
        n.arguments[0].properties.length > 0,
    );
    const layer = declarator(ast, "layerWsRpc");
    const layerSource = layer ? code.slice(layer.node.start, layer.node.end) : "";
    if (
      handlers.length !== 1 ||
      !/\bcurrentSession\b/.test(layerSource) ||
      !/const config = yield\* ServerConfig\.ServerConfig;/.test(layerSource)
    ) {
      warn("ServerWsRpcGroup.of");
      return 0;
    }
    ms.appendRight(
      handlers[0].node.arguments[0].properties.at(-1).end,
      `, [${JSON.stringify(RPC_METHOD)}]: (__zhPayload) => Effect.promise(() => __zhTranslation.handleRpc(__zhPayload, { stateDir: config.stateDir, scopes: currentSession.scopes }))`,
    );
    return 1;
  },

  "apps/server/src/orchestration-v2/ProviderTurnStartService.ts"(code, ast, ms, warn) {
    const userText = find(
      ast,
      (n, ancestors) =>
        n.type === "VariableDeclarator" &&
        n.id?.type === "Identifier" &&
        n.id.name === "userText" &&
        composerContextTextProperty(n.init, code) !== null &&
        inGenerator(ancestors),
    );
    if (userText.length !== 1 || !/import \* as ServerConfig from/.test(code)) {
      warn("userText");
      return 0;
    }
    const value = composerContextTextProperty(userText[0].node.init, code).value;
    const messageName = code.slice(value.object.start, value.object.end);
    // A queued run can start after a restart, before any client connects, so this hook also names the state directory.
    ms.overwrite(
      value.start,
      value.end,
      `(yield* Effect.flatMap(Effect.serviceOption(ServerConfig.ServerConfig), (__zhConfig) => Effect.promise(() => __zhTranslation.translateUserMessage(${messageName}, { stateDir: __zhConfig._tag === "Some" ? __zhConfig.value.stateDir : undefined }))))`,
    );
    return 1;
  },

  "apps/server/src/orchestration-v2/ProviderTurnControlService.ts"(code, ast, ms, warn) {
    const steerText = find(ast, (n, ancestors) => {
      if (composerContextTextProperty(n, code) === null || !inGenerator(ancestors)) return false;
      return ancestors.some(
        (ancestor) => ancestor.type === "CallExpression" && calleeName(ancestor.callee, code).endsWith(".steerTurn"),
      );
    });
    if (steerText.length !== 1) {
      warn("steerTurn");
      return 0;
    }
    const value = composerContextTextProperty(steerText[0].node, code).value;
    ms.overwrite(
      value.start,
      value.end,
      "(yield* Effect.promise(() => __zhTranslation.translateUserMessage(message)))",
    );
    return 1;
  },

  // Every live answer to a question, approval, or plan passes through this one call.
  "apps/server/src/orchestration-v2/RuntimeRequestService.ts"(code, ast, ms, warn) {
    const responses = find(
      ast,
      (n, ancestors) =>
        n.type === "CallExpression" &&
        calleeName(n.callee, code).endsWith(".respondToRuntimeRequest") &&
        inGenerator(ancestors),
    );
    const valueOf = (name) =>
      responses.length === 1
        ? find(
            responses[0].node,
            (n) =>
              n.type === "Property" &&
              n.key?.type === "Identifier" &&
              n.key.name === name &&
              code.slice(n.value.start, n.value.end) === `input.${name}`,
          ).map((match) => match.node.value)
        : [];
    const answers = valueOf("answers");
    const feedback = valueOf("feedback");
    if (
      answers.length !== 1 ||
      feedback.length !== 1 ||
      !/const projections = yield\* ProjectionStore\.ProjectionStoreV2;/.test(code)
    ) {
      warn("respondToRuntimeRequest");
      return 0;
    }
    // The request's questions tell an offered option from text the user typed.
    ms.overwrite(
      answers[0].start,
      answers[0].end,
      "(yield* Effect.flatMap(Effect.orElseSucceed(projections.getRuntimeResponseContext(input.threadId, input.requestId), () => undefined), (__zhContext) => Effect.promise(() => __zhTranslation.translateAnswers(input.answers, { threadId: input.threadId, questions: __zhContext?.item?.questions }))))",
    );
    ms.overwrite(
      feedback[0].start,
      feedback[0].end,
      "(yield* Effect.promise(() => __zhTranslation.translateFeedback(input.feedback, { threadId: input.threadId })))",
    );
    return 2;
  },
};

/** Wraps an element whose `attribute` carries agent-written markdown so it renders the translation. */
function wrapMarkdownElement(element, attribute, code, ms, open, close) {
  const expression = jsxAttribute(element, attribute).value.expression;
  ms.overwrite(expression.start, expression.end, "__zhText");
  ms.prependLeft(element.start, `${open}{(__zhText) => (`);
  ms.appendRight(element.end, `)}${close}`);
}

const WEB_TRANSFORMERS = {
  "packages/contracts/src/rpc.ts": transformContracts,

  // A translation can outlast the 15s slow-request warning, which is about connection health.
  "apps/web/src/rpc/requestLatencyState.ts"(code, ast, ms, warn) {
    const init = declarator(ast, "untrackedRpcAckMethods")?.node.init;
    const list = init?.type === "NewExpression" ? init.arguments?.[0] : undefined;
    if (list?.type !== "ArrayExpression" || list.elements.length === 0) {
      warn("untrackedRpcAckMethods");
      return 0;
    }
    ms.appendRight(list.elements.at(-1).end, `, ${JSON.stringify(RPC_METHOD)}`);
    return 1;
  },

  "apps/web/src/components/chat/TimelineAssistantRows.tsx"(code, ast, ms, warn) {
    const row = find(ast, (n) => n.type === "FunctionDeclaration" && n.id?.name === "AssistantTimelineRow")[0];
    const markdown = row
      ? find(row.node, (n) => n.type === "JSXElement" && jsxName(n) === "ChatMarkdown")
      : [];
    const source = row ? code.slice(row.node.start, row.node.end) : "";
    let applied = 0;
    if (
      markdown.length !== 1 ||
      jsxAttributeSource(markdown[0].node, "text", code) !== "messageText" ||
      !/\brow\.message\.streaming\b/.test(source) ||
      !/\bconst ctx = use\(TimelineRowCtx\)/.test(source)
    ) {
      warn("AssistantTimelineRow");
    } else {
      const element = markdown[0].node;
      for (const { node } of find(element.openingElement, (n) => n.type === "Identifier" && n.name === "messageText")) {
        ms.overwrite(node.start, node.end, "__zhText");
      }
      ms.prependLeft(
        element.start,
        "<__zhT.AssistantTranslation text={messageText} streaming={Boolean(row.message.streaming)} environmentId={ctx.activeThreadEnvironmentId} threadId={ctx.threadRef?.threadId}>{(__zhText) => (",
      );
      ms.appendRight(element.end, ")}</__zhT.AssistantTranslation>");
      applied += 1;
    }

    // The card receives the translation as its plan, so its title, preview, and copy follow what is shown.
    const planRow = find(ast, (n) => n.type === "FunctionDeclaration" && n.id?.name === "ProposedPlanTimelineRow")[0];
    const cards = planRow ? find(planRow.node, (n) => n.type === "JSXElement" && jsxName(n) === "ProposedPlanCard") : [];
    if (
      cards.length !== 1 ||
      jsxAttributeSource(cards[0].node, "planMarkdown", code) !== "row.proposedPlan.planMarkdown" ||
      !/\bconst ctx = use\(TimelineRowCtx\)/.test(code.slice(planRow.node.start, planRow.node.end))
    ) {
      warn("ProposedPlanTimelineRow");
    } else {
      wrapMarkdownElement(
        cards[0].node,
        "planMarkdown",
        code,
        ms,
        "<__zhT.AssistantTranslation text={row.proposedPlan.planMarkdown} streaming={false} environmentId={ctx.activeThreadEnvironmentId} threadId={ctx.threadRef?.threadId}>",
        "</__zhT.AssistantTranslation>",
      );
      applied += 1;
    }
    return applied;
  },

  // The pending question above the composer. Answers still carry the original option values.
  "apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx"(code, ast, ms, warn) {
    const card = declarator(ast, "ComposerPendingUserInputCard");
    const props = "environmentId={threadRef.environmentId} threadId={threadRef.threadId}";
    const inline = new Set(["activeQuestion.header", "activeQuestion.question", "option.label", "option.description"]);
    const texts = card
      ? find(
          card.node,
          (n, ancestors) =>
            n.type === "JSXExpressionContainer" &&
            ancestors.at(-1)?.type === "JSXElement" &&
            inline.has(code.slice(n.expression.start, n.expression.end)),
        )
      : [];
    const markdown = card
      ? find(
          card.node,
          (n) =>
            n.type === "JSXElement" &&
            jsxName(n) === "ChatMarkdown" &&
            jsxAttributeSource(n, "text", code) === "activeQuestion.question",
        )
      : [];
    if (
      texts.length !== inline.size ||
      new Set(texts.map(({ node }) => code.slice(node.expression.start, node.expression.end))).size !== inline.size ||
      markdown.length !== 1 ||
      !/^\s+threadRef: ScopedThreadRef;$/m.test(code.slice(card.node.start, card.node.end))
    ) {
      warn("ComposerPendingUserInputCard");
      return 0;
    }
    for (const { node } of texts) {
      const expression = code.slice(node.expression.start, node.expression.end);
      ms.overwrite(node.start, node.end, `<__zhT.QuestionText text={${expression}} ${props} />`);
    }
    wrapMarkdownElement(
      markdown[0].node,
      "text",
      code,
      ms,
      `<__zhT.QuestionText text={activeQuestion.question} ${props}>`,
      "</__zhT.QuestionText>",
    );
    return texts.length + 1;
  },

  "apps/web/src/components/chat/ChatComposer.tsx"(code, ast, ms, warn) {
    const actions = find(ast, (n) => n.type === "JSXElement" && jsxName(n) === "ComposerFooterPrimaryActions");
    if (actions.length !== 1 || !/^\s+routeThreadRef,$/m.test(code) || !/^\s+environmentId,$/m.test(code)) {
      warn("ComposerFooterPrimaryActions");
      return 0;
    }
    ms.appendRight(
      actions[0].node.openingElement.end,
      "<__zhT.ComposerTranslationToggle environmentId={environmentId} threadId={routeThreadRef.threadId} />",
    );
    return 1;
  },

  "apps/web/src/components/chat/TimelineUserMessageRow.tsx"(code, ast, ms, warn) {
    const row = find(ast, (n) => n.type === "FunctionDeclaration" && n.id?.name === "UserTimelineRow")[0];
    const bodies = row
      ? find(
          row.node,
          (n) =>
            n.type === "JSXElement" &&
            jsxName(n) === "CollapsibleUserMessageBody" &&
            jsxAttributeSource(n, "text", code) === "resolvedContext.text",
        )
      : [];
    const wrapper = bodies[0]?.ancestors.at(-1);
    const source = row ? code.slice(row.node.start, row.node.end) : "";
    if (
      bodies.length !== 1 ||
      wrapper?.type !== "JSXElement" ||
      !/\brow\.message\b/.test(source) ||
      !/\bconst ctx = use\(TimelineRowCtx\)/.test(source)
    ) {
      warn("UserTimelineRow");
      return 0;
    }
    // The wrapper sits in a conditional branch, which takes a single element.
    ms.prependLeft(wrapper.start, "<>");
    ms.appendRight(
      wrapper.end,
      "<__zhT.SentTranslation environmentId={ctx.activeThreadEnvironmentId} threadId={ctx.threadRef?.threadId} messageId={row.message.id} /></>",
    );
    return 1;
  },
};

// The mobile list is virtualized, so a mounted row is a visible one; translating on mount is enough.
const MOBILE_TRANSFORMERS = {
  "packages/contracts/src/rpc.ts": transformContracts,

  "apps/mobile/src/features/threads/ThreadFeed.tsx"(code, ast, ms, warn) {
    const render = find(ast, (n) => n.type === "FunctionDeclaration" && n.id?.name === "renderFeedEntry")[0];
    const source = render ? code.slice(render.node.start, render.node.end) : "";
    const markdown = render
      ? find(
          render.node,
          (n) =>
            n.type === "JSXElement" &&
            jsxName(n) === "AssistantMarkdownContent" &&
            jsxAttributeSource(n, "markdown", code) === "renderedText",
        )
      : [];
    const workLogs = render ? find(render.node, (n) => n.type === "JSXElement" && jsxName(n) === "ThreadWorkLog") : [];
    if (
      markdown.length !== 1 ||
      workLogs.length !== 1 ||
      !/\|\s*"threadId"/.test(source) ||
      !/\bmessage\.streaming\b/.test(source)
    ) {
      warn("renderFeedEntry");
      return 0;
    }
    wrapMarkdownElement(
      markdown[0].node,
      "markdown",
      code,
      ms,
      "<__zhT.AssistantTranslation text={renderedText} streaming={Boolean(message.streaming)} environmentId={props.environmentId} threadId={props.threadId}>",
      "</__zhT.AssistantTranslation>",
    );
    // The work log knows its environment but not the thread it is shown in.
    ms.appendLeft(workLogs[0].node.openingElement.name.end, " __zhThreadId={props.threadId}");
    return 2;
  },

  // The card receives the translation as its plan, so its title and copy follow what is shown.
  "apps/mobile/src/features/threads/thread-work-log.tsx"(code, ast, ms, warn) {
    const log = find(ast, (n) => n.type === "FunctionDeclaration" && n.id?.name === "ThreadWorkLog")[0];
    const cards = log
      ? find(
          log.node,
          (n) =>
            n.type === "JSXElement" &&
            jsxName(n) === "ProposedPlanCard" &&
            jsxAttributeSource(n, "markdown", code) === "plan.markdown",
        )
      : [];
    if (cards.length !== 1 || !/\bprops\.environmentId\b/.test(code.slice(log.node.start, log.node.end))) {
      warn("ThreadWorkLog");
      return 0;
    }
    wrapMarkdownElement(
      cards[0].node,
      "markdown",
      code,
      ms,
      "<__zhT.AssistantTranslation text={plan.markdown} streaming={false} environmentId={props.environmentId} threadId={props.__zhThreadId}>",
      "</__zhT.AssistantTranslation>",
    );
    return 1;
  },

  // The pending question above the composer. Answers still carry the original option values.
  "apps/mobile/src/features/threads/PendingUserInputCard.tsx"(code, ast, ms, warn) {
    const card = find(ast, (n) => n.type === "FunctionDeclaration" && n.id?.name === "PendingUserInputCard")[0];
    const inline = new Set(["question.header", "option.label", "description"]);
    const texts = card
      ? find(
          card.node,
          (n, ancestors) =>
            n.type === "JSXExpressionContainer" &&
            ancestors.at(-1)?.type === "JSXElement" &&
            jsxName(ancestors.at(-1)) === "Text" &&
            inline.has(code.slice(n.expression.start, n.expression.end)),
        )
      : [];
    const questionText = find(ast, (n) => n.type === "FunctionDeclaration" && n.id?.name === "QuestionText")[0];
    const markdown = questionText
      ? find(
          questionText.node,
          (n) =>
            n.type === "CallExpression" &&
            calleeName(n.callee, code) === "useLiveThreadLinkLabels" &&
            code.slice(n.arguments[0]?.start, n.arguments[0]?.end) === "props.markdown",
        )
      : [];
    const questionSource = questionText ? code.slice(questionText.node.start, questionText.node.end) : "";
    if (
      texts.length !== inline.size ||
      new Set(texts.map(({ node }) => code.slice(node.expression.start, node.expression.end))).size !== inline.size ||
      markdown.length !== 1 ||
      !/readonly threadId: ThreadId;/.test(questionSource) ||
      !/\bprops\.threadId\b/.test(code.slice(card.node.start, card.node.end))
    ) {
      warn("PendingUserInputCard");
      return 0;
    }
    const props = "environmentId={props.environmentId} threadId={props.threadId}";
    for (const { node } of texts) {
      const expression = code.slice(node.expression.start, node.expression.end);
      ms.overwrite(node.start, node.end, `<__zhT.QuestionText text={${expression}} ${props} />`);
    }
    const argument = markdown[0].node.arguments[0];
    ms.overwrite(
      argument.start,
      argument.end,
      "__zhT.useAgentText(props.markdown, props.environmentId, props.threadId)",
    );
    return texts.length + 1;
  },

  "apps/mobile/src/features/threads/ThreadComposer.tsx"(code, ast, ms, warn) {
    const slots = find(
      ast,
      (n, ancestors) =>
        n.type === "JSXExpressionContainer" &&
        n.expression?.type === "Identifier" &&
        n.expression.name === "modelControl" &&
        ancestors.at(-1)?.type === "JSXElement",
    );
    if (
      slots.length !== 1 ||
      !/\bconst usesLargeControls\b/.test(code) ||
      !/\bprops\.selectedThread\.id\b/.test(code) ||
      !/\breadonly environmentId: EnvironmentId;/.test(code)
    ) {
      warn("modelControl");
      return 0;
    }
    ms.appendRight(
      slots[0].node.end,
      '<__zhT.ComposerTranslationToggle environmentId={props.environmentId} threadId={props.selectedThread.id} size={usesLargeControls ? "large" : "regular"} />',
    );
    return 1;
  },
};

function relativePath(file, targets, root) {
  const normalized = String(file ?? "").split("?")[0].split("\\").join("/");
  const base = (root || process.env.T3CODE_ZH_ROOT || path.resolve(__dirname, "..")).split("\\").join("/");
  if (normalized.startsWith(`${base}/`)) return normalized.slice(base.length + 1);
  // Builds run from an isolated copy can see the same sources under another root.
  return targets.find((target) => normalized.endsWith(`/${target}`)) ?? normalized;
}

function transformWithMap(code, file, transformers, specifier, binding, options) {
  if (!isTranslationEnabled()) return null;
  const rel = relativePath(file, Object.keys(transformers), options.root);
  const transformer = transformers[rel];
  // Every hook leaves either the method name or the runtime import behind.
  if (!transformer || code.includes(JSON.stringify(RPC_METHOD)) || code.includes(specifier)) return null;

  const parsed = parseSync(file, code, { lang: rel.endsWith(".tsx") ? "tsx" : "ts", sourceType: "module" });
  const warnings = [];
  const warn = (hook) => {
    warnings.push(`${rel}#${hook}`);
    if (!options.silent) console.warn(`::warning::translation hook anchor not found in ${rel}: ${hook}`);
  };
  if (parsed.errors.length > 0) {
    warn(`parse error: ${parsed.errors[0].message}`);
    return null;
  }
  const ms = new MagicString(code);
  if (transformer(code, parsed.program, ms, warn) === 0) return { code, map: null, warnings };
  // Hooks that only extend a list reference nothing from the runtime module.
  if (ms.toString().includes(`${binding}.`)) ms.prepend(`import * as ${binding} from "${specifier}";\n`);
  return { code: ms.toString(), map: ms.generateMap({ hires: "boundary", source: file }), warnings };
}

/** Returns `{ code, map, warnings }` for a translation target, or null for any other file. */
function transformTranslationServerWithMap(code, file, options = {}) {
  return transformWithMap(code, file, SERVER_TRANSFORMERS, RUNTIME_SPECIFIER, "__zhTranslation", options);
}

function transformTranslationWebWithMap(code, file, options = {}) {
  return transformWithMap(code, file, WEB_TRANSFORMERS, WEB_SPECIFIER, "__zhT", options);
}

function transformTranslationMobileWithMap(code, file, options = {}) {
  return transformWithMap(code, file, MOBILE_TRANSFORMERS, MOBILE_SPECIFIER, "__zhT", options);
}

module.exports = {
  RPC_METHOD,
  RUNTIME_SPECIFIER,
  WEB_SPECIFIER,
  MOBILE_SPECIFIER,
  SERVER_TARGET_FILES: Object.keys(SERVER_TRANSFORMERS),
  WEB_TARGET_FILES: Object.keys(WEB_TRANSFORMERS),
  MOBILE_TARGET_FILES: Object.keys(MOBILE_TRANSFORMERS),
  isTranslationEnabled,
  transformTranslationServerWithMap,
  transformTranslationWebWithMap,
  transformTranslationMobileWithMap,
};
