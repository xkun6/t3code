// Build-time & dev-time AST transformer that wires Reclaude (`rec` / `reclaude`) and
// Recodex (`recx` / `recodex`) CLI support into T3 Code's server drivers, providers, adapters,
// and text-generation services without touching upstream source files on disk.
"use strict";

const path = require("node:path");
const { parseSync } = require("oxc-parser");
const MagicString = require("magic-string").default;

const RUNTIME_SPECIFIER = "t3code:reclaude-runtime";
const DEV_HOOK_MARKER = "zh/server-dev-hook.cjs";

function isReclaudeEnabled() {
  return process.env.T3CODE_RECLAUDE !== "0";
}

function normalizeRelPath(file, root) {
  const baseRoot = root || process.env.T3CODE_ZH_ROOT || path.resolve(__dirname, "..");
  const cleanFile = String(file ?? "").split("?")[0];
  const rel = path.relative(baseRoot, cleanFile).split(path.sep).join("/");
  if (!rel.startsWith("..")) return rel;
  // Also match suffix if built from an isolated copy with a different root env.
  const normalized = cleanFile.split("\\").join("/");
  const idx = normalized.indexOf("apps/server/src/");
  return idx >= 0 ? normalized.slice(idx) : rel;
}

function walkAst(node, visit, parent = null) {
  if (!node || typeof node !== "object") return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === "string") walkAst(item, visit, node);
      }
    } else if (child && typeof child.type === "string") {
      walkAst(child, visit, node);
    }
  }
}

function findNodes(ast, predicate) {
  const matches = [];
  walkAst(ast, (node, parent) => {
    if (predicate(node, parent)) matches.push({ node, parent });
  });
  return matches;
}

function calleeName(callee, code) {
  if (!callee) return "";
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed) {
    const obj = calleeName(callee.object, code);
    const prop = callee.property?.name || "";
    return obj && prop ? `${obj}.${prop}` : code.slice(callee.start, callee.end);
  }
  return code.slice(callee.start, callee.end);
}

function declaratorByName(ast, name) {
  const found = findNodes(
    ast,
    (n) => n.type === "VariableDeclarator" && n.id?.type === "Identifier" && n.id.name === name,
  );
  return found[0] ?? null;
}

function enclosingStatement(ast, targetNode) {
  let result = null;
  function search(node, stmt) {
    if (!node || typeof node !== "object" || result) return;
    const nextStmt =
      node.type.endsWith("Statement") || node.type.endsWith("Declaration") ? node : stmt;
    if (node === targetNode) {
      result = nextStmt;
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item.type === "string") search(item, nextStmt);
        }
      } else if (child && typeof child.type === "string") {
        search(child, nextStmt);
      }
    }
  }
  search(ast, null);
  return result;
}

function prependRuntimeImport(ms, code) {
  const importLine = `import * as __reclaude from "${RUNTIME_SPECIFIER}";\n`;
  if (code.startsWith("#!")) {
    const newline = code.indexOf("\n");
    ms.appendLeft(newline >= 0 ? newline + 1 : 0, importLine);
  } else {
    ms.prepend(importLine);
  }
}

const FILE_TRANSFORMERS = {
  "apps/server/src/provider/Drivers/ClaudeHome.ts"(code, ast, ms, warn) {
    let applied = 0;

    const resolveDecl = declaratorByName(ast, "resolveClaudeHomePath");
    const returnStmts = resolveDecl
      ? findNodes(
          resolveDecl.node,
          (n) =>
            n.type === "ReturnStatement" &&
            n.argument &&
            code.slice(n.argument.start, n.argument.end).includes('".claude"'),
        )
      : [];
    if (returnStmts.length === 1) {
      const ret = returnStmts[0].node;
      ms.appendLeft(
        ret.start,
        'const __reclaudeHome = __reclaude.resolveReclaudeHomeDir("claude", config, home, environment);\n  if (__reclaudeHome) return path.resolve(__reclaudeHome);\n  ',
      );
      applied += 1;
    } else {
      warn("resolveClaudeHomePath");
    }

    const envDecl = declaratorByName(ast, "makeClaudeEnvironment");
    const emptyChecks = envDecl
      ? findNodes(
          envDecl.node,
          (n) =>
            n.type === "IfStatement" &&
            code.slice(n.test.start, n.test.end).replace(/\s+/g, "") === "homePath.length===0",
        )
      : [];
    if (emptyChecks.length === 1) {
      const ifNode = emptyChecks[0].node;
      ms.overwrite(
        ifNode.start,
        ifNode.end,
        'if (homePath.length === 0) {\n    const __reclaudeHome = (resolvedBaseEnv.CLAUDE_CONFIG_DIR ?? "").trim().length === 0 ? __reclaude.resolveReclaudeHomeDir("claude", config, yield* HostProcess.HomeDirectory, resolvedBaseEnv) : undefined;\n    return __reclaudeHome ? { ...resolvedBaseEnv, CLAUDE_CONFIG_DIR: (yield* Path.Path).resolve(__reclaudeHome) } : resolvedBaseEnv;\n  }',
      );
      applied += 1;
    } else {
      warn("makeClaudeEnvironment");
    }

    return applied;
  },

  "apps/server/src/provider/Drivers/ClaudeDriver.ts"(code, ast, ms, warn) {
    let applied = 0;

    const accountCalls = findNodes(
      ast,
      (n) =>
        n.type === "CallExpression" &&
        calleeName(n.callee, code) === "ClaudeResetCredits.claudeAccountConfigPath" &&
        n.arguments?.[0]?.type === "ConditionalExpression",
    );
    if (accountCalls.length === 1) {
      const condTest = accountCalls[0].node.arguments[0].test;
      ms.prependLeft(condTest.start, "(");
      ms.appendRight(condTest.end, " || __reclaude.isReclaudeClaude(effectiveConfig))");
      applied += 1;
    } else {
      warn("claudeAccountConfigPath");
    }

    const statusCalls = findNodes(
      ast,
      (n) =>
        n.type === "CallExpression" &&
        calleeName(n.callee, code) === "checkClaudeProviderStatus" &&
        n.arguments?.[6]?.type === "ArrowFunctionExpression",
    );
    if (statusCalls.length === 1) {
      const resetArrowBody = statusCalls[0].node.arguments[6].body;
      ms.prependLeft(
        resetArrowBody.start,
        "(__reclaude.isReclaudeClaude(effectiveConfig) ? Effect.succeed(undefined) : (",
      );
      ms.appendRight(resetArrowBody.end, "))");
      applied += 1;
    } else {
      warn("skipClaudeResetCredits");
    }

    return applied;
  },

  "apps/server/src/provider/ClaudeProvider.ts"(code, ast, ms, warn) {
    let applied = 0;

    const probeDecl = declaratorByName(ast, "probeClaudeCapabilities");
    if (probeDecl) {
      const tryPromises = findNodes(
        probeDecl.node,
        (n) =>
          n.type === "ReturnStatement" &&
          n.argument?.type === "YieldExpression" &&
          code.slice(n.argument.start, n.argument.end).includes("buildClaudeCapabilitiesProbeQueryOptions"),
      );
      const buildOptsCalls = findNodes(
        probeDecl.node,
        (n) =>
          n.type === "CallExpression" &&
          calleeName(n.callee, code) === "buildClaudeCapabilitiesProbeQueryOptions",
      );
      if (tryPromises.length === 1 && buildOptsCalls.length === 1) {
        const retStmt = tryPromises[0].node;
        ms.appendLeft(
          retStmt.start,
          'if (__reclaude.isReclaudeClaude(claudeSettings)) {\n      const __recAuth = yield* Effect.promise(() => __reclaude.checkReclaudeAuth("claude", { binaryPath: executablePath, launchArgs: claudeSettings.launchArgs, env: claudeEnvironment }));\n      if (!__recAuth.ok) return yield* new ClaudeCapabilitiesProbeSdkError({ operation: "initialize", cause: new Error(__recAuth.message) });\n    }\n    ',
        );
        const buildCall = buildOptsCalls[0].node;
        ms.prependLeft(buildCall.start, "({ ...");
        ms.appendRight(
          buildCall.end,
          ', ...(__reclaude.isReclaudeClaude(claudeSettings) ? { executableArgs: __reclaude.reclaudePrefixArgs("claude", claudeSettings) } : {}) })',
        );
        applied += 1;
      } else {
        warn("probeClaudeCapabilities");
      }
    } else {
      warn("probeClaudeCapabilities");
    }

    const runCmdDecl = declaratorByName(ast, "runClaudeCommand");
    const spawnCalls = runCmdDecl
      ? findNodes(
          runCmdDecl.node,
          (n) => n.type === "CallExpression" && calleeName(n.callee, code) === "resolveSpawnCommand",
        )
      : [];
    if (spawnCalls.length === 1 && spawnCalls[0].node.arguments?.[1]) {
      const arg1 = spawnCalls[0].node.arguments[1];
      ms.prependLeft(arg1.start, "__reclaude.rewriteClaudeCliArgs(claudeSettings, ");
      ms.appendRight(arg1.end, ")");
      applied += 1;
    } else {
      warn("runClaudeCommand");
    }

    const checkDecl = declaratorByName(ast, "checkClaudeProviderStatus");
    const probeResultVar = checkDecl
      ? findNodes(
          checkDecl.node,
          (n) =>
            n.type === "VariableDeclarator" &&
            n.id?.type === "Identifier" &&
            n.id.name === "probeResult",
        )
      : [];
    if (probeResultVar.length === 1) {
      const stmt = enclosingStatement(checkDecl.node, probeResultVar[0].node);
      if (stmt) {
        ms.appendLeft(
          stmt.start,
          'if (__reclaude.isReclaudeClaude(claudeSettings)) {\n    const __recAuth = yield* Effect.promise(() => __reclaude.checkReclaudeAuth("claude", { binaryPath: claudeSettings.binaryPath, launchArgs: claudeSettings.launchArgs, env: resolvedEnvironment }));\n    if (!__recAuth.ok) {\n      const __recModels = claudeProviderModels(resolveClaudeModelsForVersion(modelCatalog, parsedVersion), claudeSettings.customModels);\n      const __recSkills = yield* discoverClaudeSkills(claudeSettings, cwd, resolvedEnvironment);\n      return buildServerProvider({\n        presentation: CLAUDE_PRESENTATION,\n        enabled: claudeSettings.enabled,\n        checkedAt,\n        models: __recModels,\n        updateRequiredModels,\n        slashCommands: [COMPACT_SLASH_COMMAND],\n        skills: __recSkills,\n        probe: {\n          installed: true,\n          version: parsedVersion,\n          status: "error",\n          auth: { status: "unauthenticated" },\n          message: __recAuth.message,\n        },\n      });\n    }\n  }\n  ',
        );
        applied += 1;
      } else {
        warn("checkClaudeProviderStatus");
      }
    } else {
      warn("checkClaudeProviderStatus");
    }

    return applied;
  },

  "apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts"(code, ast, ms, warn) {
    let applied = 0;

    const runnerDecl = declaratorByName(ast, "layerQueryRunner");
    const binPathVars = runnerDecl
      ? findNodes(
          runnerDecl.node,
          (n) =>
            n.type === "VariableDeclarator" &&
            n.id?.type === "Identifier" &&
            n.id.name === "binaryPath" &&
            n.init &&
            code.slice(n.init.start, n.init.end).includes("pathToClaudeCodeExecutable"),
        )
      : [];
    if (binPathVars.length === 1) {
      const stmt = enclosingStatement(runnerDecl.node, binPathVars[0].node);
      if (stmt) {
        ms.appendRight(
          stmt.end,
          '\n          if (__reclaude.isReclaudeClaude(binaryPath)) {\n            const __recAuth = yield* Effect.promise(() => __reclaude.checkReclaudeAuth("claude", { binaryPath, args: queryOptions.executableArgs, env: queryOptions.env }));\n            if (!__recAuth.ok) return yield* Effect.fail(queryRunnerError(new Error(__recAuth.message), "query"));\n          }',
        );
        applied += 1;
      } else {
        warn("queryRunnerOpenAuth");
      }
    } else {
      warn("queryRunnerOpenAuth");
    }

    const parseCalls = findNodes(
      ast,
      (n) =>
        n.type === "CallExpression" &&
        calleeName(n.callee, code) === "parseCliArgs" &&
        n.arguments?.length === 1 &&
        code.slice(n.arguments[0].start, n.arguments[0].end).replace(/\s+/g, "") ===
          "input.settings.launchArgs",
    );
    if (parseCalls.length >= 1) {
      for (const { node: call } of parseCalls) {
        const arg0 = call.arguments[0];
        ms.overwrite(
          arg0.start,
          arg0.end,
          '__reclaude.stripReclaudeLaunchArgs("claude", input.settings)',
        );
      }
      applied += 1;
    } else {
      warn("stripClaudeLaunchArgs");
    }

    const execProps = findNodes(
      ast,
      (n) =>
        (n.type === "Property" || n.type === "ObjectProperty") &&
        n.key?.type === "Identifier" &&
        n.key.name === "pathToClaudeCodeExecutable" &&
        code.slice(n.value.start, n.value.end).replace(/\s+/g, "") === "input.settings.binaryPath",
    );
    if (execProps.length === 1) {
      const prop = execProps[0].node;
      ms.appendRight(
        prop.end,
        ', ...(__reclaude.isReclaudeClaude(input.settings) ? { executableArgs: __reclaude.reclaudePrefixArgs("claude", input.settings) } : {})',
      );
      applied += 1;
    } else {
      warn("makeClaudeQueryOptionsExecutableArgs");
    }

    return applied;
  },

  "apps/server/src/textGeneration/ClaudeTextGeneration.ts"(code, ast, ms, warn) {
    let applied = 0;

    const runDecl = declaratorByName(ast, "runClaudeJson");
    const spawnCalls = runDecl
      ? findNodes(
          runDecl.node,
          (n) => n.type === "CallExpression" && calleeName(n.callee, code) === "resolveSpawnCommand",
        )
      : [];
    if (spawnCalls.length === 1 && spawnCalls[0].node.arguments?.[1]) {
      const call = spawnCalls[0].node;
      const stmt = enclosingStatement(runDecl.node, call);
      const arg1 = call.arguments[1];
      if (stmt) {
        ms.appendLeft(
          stmt.start,
          'if (__reclaude.isReclaudeClaude(claudeSettings)) {\n        const __recAuth = yield* Effect.promise(() => __reclaude.checkReclaudeAuth("claude", { binaryPath: claudeSettings.binaryPath, launchArgs: claudeSettings.launchArgs, env: claudeEnvironment }));\n        if (!__recAuth.ok) return yield* new TextGenerationError({ operation, detail: __recAuth.message });\n      }\n      ',
        );
        ms.prependLeft(arg1.start, "__reclaude.rewriteClaudeCliArgs(claudeSettings, ");
        ms.appendRight(arg1.end, ")");
        applied += 1;
      } else {
        warn("runClaudeJson");
      }
    } else {
      warn("runClaudeJson");
    }

    return applied;
  },

  "apps/server/src/provider/Drivers/CodexDriver.ts"(code, ast, ms, warn) {
    let applied = 0;

    const managedChecks = findNodes(
      ast,
      (n) =>
        n.type === "IfStatement" &&
        code.slice(n.test.start, n.test.end).replace(/\s+/g, "") === 'config.setupMode==="managed"',
    );
    if (managedChecks.length === 1) {
      const testNode = managedChecks[0].node.test;
      ms.prependLeft(testNode.start, "(");
      ms.appendRight(testNode.end, " && !__reclaude.isReclaudeCodex(config))");
      applied += 1;
    } else {
      warn("skipManagedForRecodex");
    }

    return applied;
  },

  "apps/server/src/provider/Drivers/CodexHomeLayout.ts"(code, ast, ms, warn) {
    let applied = 0;

    const layoutDecl = declaratorByName(ast, "resolveCodexHomeLayout");
    if (layoutDecl) {
      const sharedVars = findNodes(
        layoutDecl.node,
        (n) =>
          n.type === "VariableDeclarator" &&
          n.id?.type === "Identifier" &&
          n.id.name === "sharedHomePath",
      );
      const effectiveProps = findNodes(
        layoutDecl.node,
        (n) =>
          (n.type === "Property" || n.type === "ObjectProperty") &&
          n.key?.type === "Identifier" &&
          n.key.name === "effectiveHomePath" &&
          n.value?.type === "ConditionalExpression",
      );
      if (sharedVars.length === 1 && effectiveProps.length === 1) {
        const stmt = enclosingStatement(layoutDecl.node, sharedVars[0].node);
        const condTest = effectiveProps[0].node.value.test;
        if (stmt) {
          ms.overwrite(
            stmt.start,
            stmt.end,
            'const __reclaudeHome = config.homePath.trim().length === 0 ? __reclaude.resolveReclaudeHomeDir("codex", config, home) : undefined;\n  const sharedHomePath = __reclaudeHome ? path.resolve(__reclaudeHome) : resolveHomePath(path, home, config.homePath);',
          );
          ms.prependLeft(condTest.start, "(");
          ms.appendRight(condTest.end, " || Boolean(__reclaudeHome))");
          applied += 1;
        } else {
          warn("resolveCodexHomeLayout");
        }
      } else {
        warn("resolveCodexHomeLayout");
      }
    } else {
      warn("resolveCodexHomeLayout");
    }

    return applied;
  },

  "apps/server/src/provider/CodexProvider.ts"(code, ast, ms, warn) {
    let applied = 0;

    const withClientDecl = declaratorByName(ast, "withCodexAppServerClient");
    const appServerSpawns = withClientDecl
      ? findNodes(
          withClientDecl.node,
          (n) => n.type === "CallExpression" && calleeName(n.callee, code) === "resolveSpawnCommand",
        )
      : [];
    if (appServerSpawns.length === 1 && appServerSpawns[0].node.arguments?.[1]) {
      const call = appServerSpawns[0].node;
      const stmt = enclosingStatement(withClientDecl.node, call);
      const arg1 = call.arguments[1];
      if (stmt && arg1.type === "CallExpression" && arg1.arguments?.[0]) {
        const launchArgNode = arg1.arguments[0];
        ms.appendLeft(
          stmt.start,
          'if (__reclaude.isReclaudeCodex(input.binaryPath)) {\n    const __recAuth = yield* Effect.promise(() => __reclaude.checkReclaudeAuth("codex", { binaryPath: input.binaryPath, launchArgs: input.launchArgs, env: environment }));\n    if (!__recAuth.ok && !__recAuth.binaryMissing) return yield* new CodexErrors.CodexAppServerProcessExitedError({ code: 1, stderr: __recAuth.message });\n  }\n  ',
        );
        ms.overwrite(
          arg1.start,
          arg1.end,
          `__reclaude.rewriteCodexAppServerArgs(input.binaryPath, ${code.slice(launchArgNode.start, launchArgNode.end)}, codexAppServerArgs)`,
        );
        applied += 1;
      } else {
        warn("withCodexAppServerClient");
      }
    } else {
      warn("withCodexAppServerClient");
    }

    const versionDecl = declaratorByName(ast, "probeCodexCliVersion");
    const versionSpawns = versionDecl
      ? findNodes(
          versionDecl.node,
          (n) => n.type === "CallExpression" && calleeName(n.callee, code) === "resolveSpawnCommand",
        )
      : [];
    if (versionSpawns.length === 1 && versionSpawns[0].node.arguments?.[1]) {
      const arg1 = versionSpawns[0].node.arguments[1];
      ms.prependLeft(arg1.start, "__reclaude.rewriteCodexCliArgs(input, ");
      ms.appendRight(arg1.end, ")");
      applied += 1;
    } else {
      warn("probeCodexCliVersion");
    }

    const checkDecl = declaratorByName(ast, "checkCodexProviderStatus");
    const probeVars = checkDecl
      ? findNodes(
          checkDecl.node,
          (n) =>
            n.type === "VariableDeclarator" &&
            n.id?.type === "Identifier" &&
            n.id.name === "probeResult",
        )
      : [];
    if (probeVars.length === 1) {
      const stmt = enclosingStatement(checkDecl.node, probeVars[0].node);
      if (stmt) {
        ms.appendLeft(
          stmt.start,
          'if (__reclaude.isReclaudeCodex(codexSettings)) {\n    const __recLaunchArgs = resolveCodexLaunchArgs(codexSettings.launchArgs, resolvedEnvironment);\n    const __recAuth = yield* Effect.promise(() => __reclaude.checkReclaudeAuth("codex", { binaryPath: codexSettings.binaryPath, launchArgs: __recLaunchArgs, env: resolvedEnvironment }));\n    if (!__recAuth.ok && !__recAuth.binaryMissing) {\n      const __recVersion = yield* probeCodexCliVersion({ binaryPath: codexSettings.binaryPath, homePath: codexSettings.homePath, launchArgs: __recLaunchArgs, cwd: process.cwd(), environment: resolvedEnvironment });\n      return buildServerProvider({\n        presentation: CODEX_PRESENTATION,\n        enabled: codexSettings.enabled,\n        checkedAt,\n        models: emptyModels,\n        skills: [],\n        probe: {\n          installed: true,\n          version: __recVersion,\n          status: "error",\n          auth: { status: "unauthenticated" },\n          message: __recAuth.message,\n        },\n      });\n    }\n  }\n  ',
        );
        applied += 1;
      } else {
        warn("checkCodexProviderStatus");
      }
    } else {
      warn("checkCodexProviderStatus");
    }

    return applied;
  },

  "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts"(code, ast, ms, warn) {
    let applied = 0;

    const factoryDecl = declaratorByName(ast, "layerAppServerClientFactory");
    const spawnCalls = factoryDecl
      ? findNodes(
          factoryDecl.node,
          (n) =>
            n.type === "CallExpression" &&
            calleeName(n.callee, code) === "makeCodexAppServerSpawnCommand",
        )
      : [];
    const appServerArgsCalls = factoryDecl
      ? findNodes(
          factoryDecl.node,
          (n) =>
            n.type === "CallExpression" && calleeName(n.callee, code) === "codexAppServerArgs",
        )
      : [];
    if (
      spawnCalls.length === 1 &&
      appServerArgsCalls.length === 1 &&
      appServerArgsCalls[0].node.arguments?.[0]
    ) {
      const stmt = enclosingStatement(factoryDecl.node, spawnCalls[0].node);
      const argsCall = appServerArgsCalls[0].node;
      const innerArg = argsCall.arguments[0];
      if (stmt) {
        ms.appendLeft(
          stmt.start,
          'if (__reclaude.isReclaudeCodex(input.settings)) {\n          const __recAuth = yield* Effect.promise(() => __reclaude.checkReclaudeAuth("codex", { binaryPath: input.settings.binaryPath || "codex", launchArgs: resolveCodexLaunchArgs(input.settings.launchArgs, input.environment), env: environment }));\n          if (!__recAuth.ok && !__recAuth.binaryMissing) return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({ driver: CODEX_PROVIDER, providerSessionId: input.providerSessionId, cause: new Error(__recAuth.message) });\n        }\n        ',
        );
        ms.overwrite(
          argsCall.start,
          argsCall.end,
          `__reclaude.rewriteCodexAppServerArgs(input.settings.binaryPath || "codex", ${code.slice(innerArg.start, innerArg.end)}, codexAppServerArgs)`,
        );
        applied += 1;
      } else {
        warn("codexAdapterOpen");
      }
    } else {
      warn("codexAdapterOpen");
    }

    return applied;
  },

  "apps/server/src/textGeneration/CodexTextGeneration.ts"(code, ast, ms, warn) {
    let applied = 0;

    const mcpDecl = declaratorByName(ast, "listEnabledMcpServers");
    const mcpSpawns = mcpDecl
      ? findNodes(
          mcpDecl.node,
          (n) => n.type === "CallExpression" && calleeName(n.callee, code) === "resolveSpawnCommand",
        )
      : [];
    if (mcpSpawns.length === 1 && mcpSpawns[0].node.arguments?.[1]) {
      const arg1 = mcpSpawns[0].node.arguments[1];
      ms.prependLeft(
        arg1.start,
        "__reclaude.rewriteCodexCliArgs({ binaryPath: input.binary, launchArgs: input.rawLaunchArgs }, ",
      );
      ms.appendRight(arg1.end, ")");
      applied += 1;
    } else {
      warn("listEnabledMcpServers");
    }

    const runDecl = declaratorByName(ast, "runCodexJson");
    if (runDecl) {
      const execArgCalls = findNodes(
        runDecl.node,
        (n) =>
          n.type === "CallExpression" &&
          calleeName(n.callee, code) === "codexExecLaunchArgs" &&
          n.arguments?.length === 1,
      );
      const listMcpCalls = findNodes(
        runDecl.node,
        (n) =>
          n.type === "CallExpression" &&
          calleeName(n.callee, code) === "listEnabledMcpServers" &&
          n.arguments?.[0]?.type === "ObjectExpression",
      );
      const execSpawns = findNodes(
        runDecl.node,
        (n) => n.type === "CallExpression" && calleeName(n.callee, code) === "resolveSpawnCommand",
      );
      if (execArgCalls.length === 1 && listMcpCalls.length === 1 && execSpawns.length === 1) {
        const execArgCall = execArgCalls[0].node;
        const execStmt = enclosingStatement(runDecl.node, execArgCall);
        const launchArgNode = execArgCall.arguments[0];
        const mcpObj = listMcpCalls[0].node.arguments[0];
        const lastProp = mcpObj.properties[mcpObj.properties.length - 1];
        const spawnArg1 = execSpawns[0].node.arguments[1];
        if (execStmt && lastProp && spawnArg1) {
          ms.appendLeft(
            execStmt.start,
            'if (__reclaude.isReclaudeCodex(binary)) {\n        const __recAuth = yield* Effect.promise(() => __reclaude.checkReclaudeAuth("codex", { binaryPath: binary, launchArgs, env }));\n        if (!__recAuth.ok && !__recAuth.binaryMissing) return yield* new TextGenerationError({ operation, detail: __recAuth.message });\n      }\n      ',
          );
          ms.overwrite(
            launchArgNode.start,
            launchArgNode.end,
            `__reclaude.stripReclaudeLaunchArgs("codex", { binaryPath: binary, launchArgs: ${code.slice(launchArgNode.start, launchArgNode.end)} })`,
          );
          ms.appendRight(lastProp.end, ", rawLaunchArgs: launchArgs");
          ms.prependLeft(
            spawnArg1.start,
            "__reclaude.rewriteCodexCliArgs({ binaryPath: binary, launchArgs }, ",
          );
          ms.appendRight(spawnArg1.end, ")");
          applied += 1;
        } else {
          warn("runCodexJson");
        }
      } else {
        warn("runCodexJson");
      }
    } else {
      warn("runCodexJson");
    }

    return applied;
  },
};

const TARGET_FILES = Object.keys(FILE_TRANSFORMERS);

/**
 * Transforms a server TypeScript source file if it is one of the Reclaude integration targets.
 * Also strips the dev-only loader registration from `apps/server/src/bin.ts` during bundled builds.
 */
function transformReclaudeServerWithMap(code, file, options = {}) {
  if (!isReclaudeEnabled()) return null;
  const rel = normalizeRelPath(file, options.root);

  if (options.bundle === true && rel === "apps/server/src/bin.ts" && code.includes(DEV_HOOK_MARKER)) {
    const ms = new MagicString(code);
    const lines = code.split("\n");
    let offset = 0;
    for (const line of lines) {
      const end = offset + line.length + (offset + line.length < code.length ? 1 : 0);
      if (line.includes(DEV_HOOK_MARKER)) {
        ms.remove(offset, end);
      }
      offset = end;
    }
    return {
      code: ms.toString(),
      map: ms.generateMap({ hires: "boundary", source: file }),
      warnings: [],
    };
  }

  const transformer = FILE_TRANSFORMERS[rel];
  if (!transformer) return null;
  if (code.includes(RUNTIME_SPECIFIER)) return null;

  const parsed = parseSync(file, code, {
    lang: file.endsWith(".tsx") ? "tsx" : "ts",
    sourceType: "module",
  });
  if (parsed.errors.length > 0) {
    const warning = `parse error in ${rel}: ${parsed.errors[0].message}`;
    if (!options.silent) console.warn(`::warning::reclaude overlay skipped (${warning})`);
    return null;
  }

  const ms = new MagicString(code);
  const warnings = [];
  const applied = transformer(code, parsed.program, ms, (hookName) => {
    warnings.push(`${rel}#${hookName}`);
    if (!options.silent) {
      console.warn(`::warning::reclaude hook anchor not found in ${rel}: ${hookName}`);
    }
  });
  if (applied === 0) return null;

  prependRuntimeImport(ms, code);
  return {
    code: ms.toString(),
    map: ms.generateMap({ hires: "boundary", source: file }),
    warnings,
  };
}

function transformReclaudeServer(code, file, options = {}) {
  const result = transformReclaudeServerWithMap(code, file, options);
  return result ? result.code : code;
}

module.exports = {
  RUNTIME_SPECIFIER,
  TARGET_FILES,
  isReclaudeEnabled,
  transformReclaudeServer,
  transformReclaudeServerWithMap,
};
