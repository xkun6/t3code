// Runtime helpers for Reclaude (`rec` / `reclaude`) and Recodex (`recx` / `recodex`) CLI wrappers.
// Bundled into the server output by zhServerPlugin (or loaded via server-dev-hook in `vp run dev`).
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const RECLAUDE_CLAUDE_BIN_RE = /^rec(?:laude)?(?:\.(?:exe|cmd|bat))?$/i;
const RECLAUDE_CODEX_BIN_RE = /^rec(?:x|odex)(?:\.(?:exe|cmd|bat))?$/i;
const VALID_LOGIN_STATES = new Set([
  "unverified",
  "ok",
  "valid",
  "active",
  "authenticated",
  "ready",
  "present",
]);
const STATUS_CACHE_TTL_MS = 2_000;
const STATUS_TIMEOUT_MS = 4_000;
const statusCache = new Map();

function binaryPathOf(target) {
  if (typeof target === "string") return target;
  if (target && typeof target === "object" && typeof target.binaryPath === "string") {
    return target.binaryPath;
  }
  return "";
}

function launchArgsOf(target) {
  if (typeof target === "string") return "";
  if (target && typeof target === "object" && typeof target.launchArgs === "string") {
    return target.launchArgs;
  }
  return "";
}

function basenameCrossPlatform(rawPath) {
  const trimmed = String(rawPath ?? "")
    .trim()
    .replace(/^["']+|["']+$/g, "");
  if (!trimmed) return "";
  const slashIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
}

export function detectReclaudeKind(target) {
  if (process.env.T3CODE_RECLAUDE === "0") return null;
  const base = basenameCrossPlatform(binaryPathOf(target));
  if (!base) return null;
  if (RECLAUDE_CLAUDE_BIN_RE.test(base)) return "claude";
  if (RECLAUDE_CODEX_BIN_RE.test(base)) return "codex";
  return null;
}

export function isReclaudeClaude(target) {
  return detectReclaudeKind(target) === "claude";
}

export function isReclaudeCodex(target) {
  return detectReclaudeKind(target) === "codex";
}

/**
 * Scans CLI launch arguments preserving exact original substrings for non-Reclaude flags,
 * while extracting `--org <id>` / `--org=<id>` and any redundant leading `cli` subcommand.
 */
function scanCliTokenSpans(raw) {
  const text = String(raw ?? "");
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) break;
    const start = i;
    let value = "";
    let quote = null;
    while (i < text.length) {
      const ch = text[i];
      if (quote) {
        if (ch === "\\" && i + 1 < text.length && (text[i + 1] === quote || text[i + 1] === "\\")) {
          value += text[i + 1];
          i += 2;
          continue;
        }
        if (ch === quote) {
          quote = null;
          i += 1;
          continue;
        }
        value += ch;
        i += 1;
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === '"' || ch === "'") {
        quote = ch;
        i += 1;
        continue;
      }
      if (ch === "\\" && i + 1 < text.length && /\s|["']/.test(text[i + 1])) {
        value += text[i + 1];
        i += 2;
        continue;
      }
      value += ch;
      i += 1;
    }
    tokens.push({ value, raw: text.slice(start, i) });
  }
  return tokens;
}

export function splitReclaudeLaunchArgs(launchArgs) {
  const tokens = scanCliTokenSpans(launchArgs);
  const kept = [];
  let orgId;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (kept.length === 0 && orgId === undefined && token.value === "cli") {
      continue;
    }
    if (token.value === "--org") {
      const next = tokens[index + 1];
      if (next && next.value.trim().length > 0 && !next.value.startsWith("-")) {
        orgId = next.value.trim();
        index += 1;
      }
      continue;
    }
    if (token.value.startsWith("--org=")) {
      const extracted = token.value.slice("--org=".length).trim();
      if (extracted.length > 0) orgId = extracted;
      continue;
    }
    if (kept.length === 0 && token.value === "cli") {
      continue;
    }
    kept.push(token.raw);
  }

  const orgArgs = orgId ? ["--org", orgId] : [];
  return {
    orgId,
    orgArgs,
    prefixArgs: [...orgArgs, "cli"],
    remainingLaunchArgs: kept.join(" "),
  };
}

function extractOrgFromArgs(args) {
  if (!Array.isArray(args)) return undefined;
  let orgId;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] ?? "");
    if (arg === "cli") break;
    if (arg === "--org") {
      const next = args[index + 1];
      if (typeof next === "string" && next.trim().length > 0) {
        orgId = next.trim();
      }
      index += 1;
    } else if (arg.startsWith("--org=")) {
      const val = arg.slice("--org=".length).trim();
      if (val.length > 0) orgId = val;
    }
  }
  return orgId;
}

export function stripReclaudeLaunchArgs(expectedKind, settingsOrInput) {
  const raw = launchArgsOf(settingsOrInput);
  if (detectReclaudeKind(settingsOrInput) !== expectedKind) return raw;
  return splitReclaudeLaunchArgs(raw).remainingLaunchArgs;
}

export function reclaudePrefixArgs(expectedKind, settingsOrInput) {
  if (detectReclaudeKind(settingsOrInput) !== expectedKind) return [];
  return splitReclaudeLaunchArgs(launchArgsOf(settingsOrInput)).prefixArgs;
}

export function rewriteClaudeCliArgs(claudeSettings, args) {
  if (!isReclaudeClaude(claudeSettings)) return args;
  const prefix = reclaudePrefixArgs("claude", claudeSettings);
  return [...prefix, ...args];
}

export function rewriteCodexCliArgs(input, args) {
  if (!isReclaudeCodex(input)) return args;
  const prefix = reclaudePrefixArgs("codex", input);
  return [...prefix, ...args];
}

export function rewriteCodexAppServerArgs(binaryPath, launchArgs, buildAppServerArgs) {
  if (!isReclaudeCodex(binaryPath)) return buildAppServerArgs(launchArgs);
  const { prefixArgs, remainingLaunchArgs } = splitReclaudeLaunchArgs(launchArgs);
  return [...prefixArgs, ...buildAppServerArgs(remainingLaunchArgs)];
}

export function resolveReclaudeDataDir(homeDir, env) {
  const explicitDataDir = env?.RECLAUDE_DATA_DIR?.trim();
  if (explicitDataDir) return path.resolve(explicitDataDir);
  const resolvedHome =
    (typeof homeDir === "string" && homeDir.trim()) ||
    env?.USERPROFILE?.trim() ||
    env?.HOME?.trim() ||
    os.homedir();
  return path.join(resolvedHome, ".rec");
}

function isValidReclaudeSk(sk) {
  return typeof sk === "string" && sk.startsWith("sk-rec-") && sk.length >= 16;
}

function readDiskBindings(dataDir, identity) {
  const identityDir = path.join(dataDir, identity);
  const accountsDir = path.join(identityDir, "accounts");
  let entries;
  try {
    entries = fs.readdirSync(accountsDir, { withFileTypes: true });
  } catch {
    return { identityDir, accountsPresent: false, currentId: null, bindings: [] };
  }

  const bindings = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) continue;
    const deviceId = Number.parseInt(entry.name, 10);
    const accountDir = path.join(accountsDir, entry.name);
    const devicePath = path.join(accountDir, "device.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(devicePath, "utf8"));
      if (!parsed || typeof parsed !== "object") continue;
      if (Number(parsed.device_id) !== deviceId) continue;
      if (parsed.platform && parsed.platform !== identity) continue;
      bindings.push({
        deviceId,
        orgId: parsed.org_id,
        orgName: parsed.org_name,
        email: parsed.user_email,
        accountDir,
        validSk: isValidReclaudeSk(parsed.sk),
      });
    } catch {
      // Unreadable or corrupt device.json is skipped just like ScanBindingsFor.
    }
  }
  bindings.sort((a, b) => a.deviceId - b.deviceId);

  let currentId = null;
  let currentExists = false;
  try {
    const rawCurrent = fs.readFileSync(path.join(identityDir, "current"), "utf8").trim();
    currentExists = true;
    if (/^[1-9]\d*$/.test(rawCurrent)) {
      currentId = Number.parseInt(rawCurrent, 10);
    }
  } catch {
    currentExists = false;
  }

  return { identityDir, accountsPresent: true, currentExists, currentId, bindings };
}

function selectBindingFromDisk(scan, orgId) {
  if (orgId !== undefined && String(orgId).trim().length > 0) {
    const target = String(orgId).trim();
    const matched = scan.bindings.filter((b) => String(b.orgId ?? "") === target);
    if (matched.length === 1) return { binding: matched[0], reason: null };
    if (matched.length > 1) {
      const currentMatch = matched.find((b) => b.deviceId === scan.currentId);
      return { binding: currentMatch ?? matched[0], reason: null };
    }
    return { binding: null, reason: "org_not_found" };
  }
  if (scan.currentId !== null) {
    const found = scan.bindings.find((b) => b.deviceId === scan.currentId) ?? null;
    return { binding: found, reason: found ? null : "missing_current_target" };
  }
  if (!scan.currentExists && scan.bindings.length === 1) {
    return { binding: scan.bindings[0], reason: null };
  }
  return { binding: null, reason: scan.bindings.length > 1 ? "ambiguous" : "missing" };
}

function bindingHomeForKind(kind, dataDir, accountDir) {
  if (kind === "claude") {
    return path.join(accountDir, "config");
  }
  const accountHome = path.join(accountDir, "home");
  if (fs.existsSync(accountHome)) return accountHome;
  const legacyHome = path.join(dataDir, "chatgpt", "home");
  if (fs.existsSync(legacyHome)) return legacyHome;
  return accountHome;
}

/**
 * Resolves the active Reclaude config/home directory synchronously from `~/.rec` when the user
 * has not explicitly configured `homePath` or `CLAUDE_CONFIG_DIR` / `CODEX_HOME`.
 */
export function resolveReclaudeHomeDir(expectedKind, settingsOrInput, homeDir, env) {
  if (detectReclaudeKind(settingsOrInput) !== expectedKind) return undefined;
  const { orgId } = splitReclaudeLaunchArgs(launchArgsOf(settingsOrInput));
  const dataDir = resolveReclaudeDataDir(homeDir, env);
  const scan = readDiskBindings(dataDir, expectedKind);
  const { binding } = selectBindingFromDisk(scan, orgId);
  if (!binding) return undefined;
  return bindingHomeForKind(expectedKind, dataDir, binding.accountDir);
}

function runStatusJson(binaryPath, env) {
  const dataDir = resolveReclaudeDataDir(undefined, env);
  const cacheKey = `${binaryPath}\0${dataDir}`;
  const now = Date.now();
  const cached = statusCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return Promise.resolve(cached.value);
  }
  return new Promise((resolve) => {
    const useShell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(binaryPath);
    execFile(
      binaryPath,
      ["status", "--json"],
      {
        env: env ?? process.env,
        timeout: STATUS_TIMEOUT_MS,
        windowsHide: true,
        shell: useShell,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          const code = error && typeof error === "object" ? error.code : undefined;
          resolve({ ok: false, enoent: code === "ENOENT", error });
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout ?? ""));
          const value = { ok: true, enoent: false, snapshot: parsed };
          statusCache.set(cacheKey, { expiresAt: Date.now() + STATUS_CACHE_TTL_MS, value });
          resolve(value);
        } catch (parseError) {
          resolve({ ok: false, enoent: false, error: parseError });
        }
      },
    );
  });
}

function formatUnauthenticatedMessage(kind, reason, orgId) {
  const cliCmd = kind === "claude" ? "rec" : "recx";
  const productLabel = kind === "claude" ? "Reclaude" : "Recodex";
  if (reason === "cli_missing") {
    const upstream = kind === "claude" ? "Claude Code (`claude`)" : "Codex CLI (`codex`)";
    return `${productLabel} 未检测到上游 ${upstream}，请先安装上游 CLI 或运行 \`${cliCmd} doctor\` 检查环境。`;
  }
  if (reason === "org_not_found" && orgId) {
    return `${productLabel} 未找到组织 \`${orgId}\` 的本机绑定，请运行 \`${cliCmd} org list\` 或 \`${cliCmd} org bind\` 后重试。`;
  }
  if (reason === "ambiguous") {
    return `${productLabel} 存在多个组织绑定但未指定默认组织，请运行 \`${cliCmd} org use\` 选择默认绑定或在启动参数中配置 \`--org <id>\`。`;
  }
  return `${productLabel} 未检测到有效登录，请先在终端运行 \`${cliCmd} login\` 完成设备授权后重试。`;
}

/**
 * Fast non-interactive auth preflight for `rec` / `recx` so T3 Code never triggers Reclaude's
 * interactive browser device-login flow inside headless background subprocesses.
 */
export async function checkReclaudeAuth(expectedKind, options = {}) {
  const binaryPath = binaryPathOf(options);
  if (detectReclaudeKind(binaryPath) !== expectedKind) {
    return { ok: true, binaryMissing: false, message: "" };
  }

  const env = options.env ?? process.env;
  const orgId =
    options.orgId ??
    splitReclaudeLaunchArgs(options.launchArgs).orgId ??
    extractOrgFromArgs(options.args);

  // Fast path (~0.1ms): valid binding with SK on disk.
  const dataDir = resolveReclaudeDataDir(options.homeDir, env);
  const scan = readDiskBindings(dataDir, expectedKind);
  const { binding, reason: diskReason } = selectBindingFromDisk(scan, orgId);
  if (binding && binding.validSk) {
    return {
      ok: true,
      binaryMissing: false,
      homeDir: bindingHomeForKind(expectedKind, dataDir, binding.accountDir),
      message: "",
    };
  }

  // Slow path (~15ms, offline): ask `<binary> status --json` in case layout changed or CLI is missing.
  const statusResult = await runStatusJson(binaryPath, env);
  if (!statusResult.ok) {
    if (statusResult.enoent) {
      return {
        ok: false,
        binaryMissing: true,
        message: `未找到可执行文件 \`${binaryPath}\`，请检查设置中的二进制路径。`,
      };
    }
    return {
      ok: false,
      binaryMissing: false,
      message: formatUnauthenticatedMessage(expectedKind, diskReason, orgId),
    };
  }

  const sectionKey = expectedKind === "claude" ? "claude" : "chatgpt";
  const section = statusResult.snapshot?.[sectionKey];
  if (section?.cli?.state === "missing") {
    return {
      ok: false,
      binaryMissing: false,
      message: formatUnauthenticatedMessage(expectedKind, "cli_missing", orgId),
    };
  }

  if (orgId !== undefined && String(orgId).trim().length > 0) {
    const bindings = Array.isArray(section?.bindings) ? section.bindings : [];
    const matched = bindings.find((b) => String(b?.org_id ?? "") === String(orgId).trim());
    if (matched) {
      const resolvedDataDir = statusResult.snapshot?.global?.data_dir || dataDir;
      const accountDir = path.join(resolvedDataDir, expectedKind, "accounts", String(matched.device_id));
      return {
        ok: true,
        binaryMissing: false,
        homeDir: bindingHomeForKind(expectedKind, resolvedDataDir, accountDir),
        message: "",
      };
    }
    return {
      ok: false,
      binaryMissing: false,
      message: formatUnauthenticatedMessage(expectedKind, "org_not_found", orgId),
    };
  }

  const loginState = String(section?.login?.state ?? "").toLowerCase();
  if (VALID_LOGIN_STATES.has(loginState) && section?.current?.device_id) {
    const resolvedDataDir = statusResult.snapshot?.global?.data_dir || dataDir;
    const accountDir = path.join(
      resolvedDataDir,
      expectedKind,
      "accounts",
      String(section.current.device_id),
    );
    return {
      ok: true,
      binaryMissing: false,
      homeDir: bindingHomeForKind(expectedKind, resolvedDataDir, accountDir),
      message: "",
    };
  }

  return {
    ok: false,
    binaryMissing: false,
    message: formatUnauthenticatedMessage(expectedKind, diskReason, orgId),
  };
}

export function __clearReclaudeCacheForTest() {
  statusCache.clear();
}
