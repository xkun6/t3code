// Build-time UI localization: rewrites English string literals in UI positions to the
// dictionary's translation. Shared by the Vite, tsdown and Metro hooks and by extract.cjs.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseSync } = require("oxc-parser");
const MagicString = require("magic-string").default;

const ROOT = process.env.T3CODE_ZH_ROOT || path.resolve(__dirname, "..");
const DICT_PATH = path.join(__dirname, "locales", "zh-Hans.json");

// Directories whose sources ship in a client UI (relative to the repo root).
const SOURCE_DIRS = [
  "apps/web/src",
  "apps/desktop/src",
  "apps/mobile/src",
  "apps/mobile/modules",
  "packages/client-runtime/src",
  "packages/shared/src",
];

const ATTR_PATTERN =
  /^(title|placeholder|label|alt|aria-label|aria-description|aria-placeholder|aria-valuetext|tooltip|description|heading|subtitle|caption|hint|helperText|emptyText|emptyMessage|message|text|accessibilityLabel|accessibilityHint|confirmLabel|cancelLabel|submitLabel|actionLabel|buttonLabel)$|(Label|Title|Description|Placeholder|Tooltip|Hint|Message)$/;
const PROP_PATTERN =
  /^(label|title|description|placeholder|message|tooltip|heading|subtitle|caption|hint|detail|helperText|emptyText|emptyMessage|accessibilityLabel|accessibilityHint|ariaLabel|confirmLabel|cancelLabel|submitLabel|actionLabel|buttonLabel|buttons|headerTitle|tabBarLabel|title_)$|(Label|Title|Description|Placeholder|Tooltip|Hint|Message)$/;
// Constants and helpers named like copy (SECTION_LABELS, SAVE_MESSAGE, stepLabel): every string
// they hold or return is UI text.
const COPY_NAME_PATTERN =
  /(^|_)(LABELS?|TITLES?|SUBTITLES?|DESCRIPTIONS?|HEADINGS?|MESSAGES?|HINTS?|PLACEHOLDERS?|TOOLTIPS?|COPY)$|(^|[a-z])(Labels?|Titles?|Subtitles?|Descriptions?|Headings?|Messages?|Hints?|Placeholders?|Tooltips?|Copy)$|^(labels?|titles?|copy)$/;
// Reads compared against string literals; those literals follow the label's translation.
const COMPARED_NAMES = /^(label|title|placeholder|description|heading)$/;
const CALL_NAMES = new Set(["toast", "alert", "confirm", "prompt", "showToast", "notify"]);
const CALL_MEMBERS = new Set([
  "toast.success",
  "toast.error",
  "toast.info",
  "toast.warning",
  "toast.message",
  "toast.loading",
  "Alert.alert",
  "Alert.prompt",
  "window.alert",
  "window.confirm",
  "window.prompt",
]);

function isSourceFile(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  if (rel.startsWith("..") || rel.includes("/node_modules/")) return false;
  if (!/\.(tsx?|jsx?|mts|cts)$/.test(rel) || /\.d\.ts$/.test(rel)) return false;
  if (/\.(test|spec|browser\.test|testkit)\.[cm]?[tj]sx?$/.test(rel)) return false;
  if (/(^|\/)(test|tests|__tests__|__mocks__|testing)\//.test(rel)) return false;
  return SOURCE_DIRS.some((dir) => rel.startsWith(`${dir}/`));
}

function langOf(file) {
  if (/\.tsx$/.test(file)) return "tsx";
  if (/\.[cm]?ts$/.test(file)) return "ts";
  return "jsx";
}

/** JSX text the way React renders it: lines trimmed, blank lines dropped, joined by spaces. */
function jsxTextValue(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  if (lines.length === 1) return raw;
  return lines
    .map((line, index) => {
      let next = line;
      if (index !== 0) next = next.replace(/^[ \t]+/, "");
      if (index !== lines.length - 1) next = next.replace(/[ \t]+$/, "");
      return next;
    })
    .filter((line) => line.length > 0)
    .join(" ");
}

const NAMED_ENTITIES = {
  quot: '"',
  apos: "'",
  amp: "&",
  lt: "<",
  gt: ">",
  nbsp: " ",
  rarr: "→",
  larr: "←",
  hellip: "…",
  middot: "·",
  mdash: "—",
  ndash: "–",
  times: "×",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
};

/** Decodes JSX text entities; null when it holds one this table does not know. */
function decodeEntities(text) {
  let unknown = false;
  const decoded = text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    if (named === undefined) unknown = true;
    return named ?? match;
  });
  return unknown ? null : decoded;
}

function hasWords(text) {
  return /[A-Za-z]{2,}/.test(text);
}

/** Heuristic for strings that are UI copy rather than identifiers, paths or code. */
function looksLikeCopy(text, kind) {
  const value = text.trim();
  if (!hasWords(value) || value.length > 500) return false;
  if (/:\/\/|^[./~]|^#[0-9a-f]{3,8}$|^\$\{|=>|\bfunction\b/.test(value)) return false;
  if (kind === "jsx-text") return true;
  if (/^[a-z0-9_.:/@-]+$/.test(value)) return false;
  if (/^[A-Z0-9_]+$/.test(value) && value.length > 3) return false;
  if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(value)) return false;
  return true;
}

function templateKey(node) {
  let key = "";
  node.quasis.forEach((quasi, index) => {
    key += (quasi.value.cooked ?? quasi.value.raw).replace(/[{}]/g, (c) => (c === "{" ? "{{" : "}}"));
    if (index < node.expressions.length) key += `{${index}}`;
  });
  return key;
}

function escapeTemplate(text) {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function placeholders(text) {
  const slots = [];
  const slot = /\{\{|\}\}|\{(\d+)\}/g;
  let match;
  while ((match = slot.exec(text)) !== null) {
    if (match[1] === undefined) continue;
    // A slot glued to a word ("favorite{1}") is an English plural suffix Chinese may drop.
    slots.push({ index: Number(match[1]), optional: /[A-Za-z]/.test(text[match.index - 1] ?? "") });
  }
  return slots;
}

/** Why a translation cannot replace its key, or null when it can. */
function checkTranslation(key, translation) {
  if (typeof translation !== "string" || translation.trim() === "") return "empty";
  const keySlots = placeholders(key);
  const known = new Set(keySlots.map((slot) => slot.index));
  const used = new Set(placeholders(translation).map((slot) => slot.index));
  for (const index of used) if (!known.has(index)) return `unknown placeholder {${index}}`;
  for (const slot of keySlots) if (!slot.optional && !used.has(slot.index)) return `missing placeholder {${slot.index}}`;
  const lead = key.match(/^\s*/)[0];
  const trail = key.match(/\s*$/)[0];
  if (!translation.startsWith(lead) || !translation.endsWith(trail)) return "leading or trailing whitespace changed";
  return null;
}

/** Rebuilds a template literal from a translation whose {n} slots name the original expressions. */
function buildTemplate(translation, expressionSources) {
  let out = "`";
  let rest = translation;
  const slot = /\{\{|\}\}|\{(\d+)\}/g;
  let last = 0;
  let match;
  while ((match = slot.exec(rest)) !== null) {
    out += escapeTemplate(rest.slice(last, match.index));
    if (match[0] === "{{") out += "{";
    else if (match[0] === "}}") out += "}";
    else {
      const index = Number(match[1]);
      if (index >= expressionSources.length) return null;
      out += "${" + expressionSources[index] + "}";
    }
    last = slot.lastIndex;
  }
  return out + escapeTemplate(rest.slice(last)) + "`";
}

function memberName(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed) {
    const object = memberName(node.object);
    return object && node.property.type === "Identifier" ? `${object}.${node.property.name}` : null;
  }
  return null;
}

function propertyKeyName(node) {
  if (node.computed) return null;
  if (node.key.type === "Identifier") return node.key.name;
  if (node.key.type === "Literal" && typeof node.key.value === "string") return node.key.value;
  return null;
}

function attributeName(node) {
  if (node.name.type === "JSXIdentifier") return node.name.name;
  if (node.name.type === "JSXNamespacedName") return `${node.name.namespace.name}:${node.name.name.name}`;
  return null;
}

/**
 * Walks one module and reports every string in a UI position.
 * `onString({ key, kind, node, replace })` gets a `replace(translation)` that edits `ms`.
 */
function visitModule(code, file, onString) {
  const parsed = parseSync(file, code, { lang: langOf(file), sourceType: "module" });
  if (parsed.errors.some((error) => error.severity === "Error")) return false;
  const ms = new MagicString(code);

  const literal = (node, kind) => {
    if (typeof node.value !== "string" || !looksLikeCopy(node.value, kind)) return;
    const inJsxAttr = kind === "jsx-attr-literal";
    onString({
      key: node.value,
      kind,
      node,
      replace: (translation) =>
        ms.overwrite(
          node.start,
          node.end,
          inJsxAttr && !/["\\\n]/.test(translation)
            ? `"${translation}"`
            : inJsxAttr
              ? `{${JSON.stringify(translation)}}`
              : JSON.stringify(translation),
        ),
    });
  };

  const template = (node, kind) => {
    const key = templateKey(node);
    if (!looksLikeCopy(node.quasis.map((q) => q.value.cooked ?? "").join(" "), kind)) return;
    const sources = node.expressions.map((expression) => code.slice(expression.start, expression.end));
    onString({
      key,
      kind,
      node,
      replace: (translation) => {
        const rebuilt = buildTemplate(translation, sources);
        if (rebuilt !== null) ms.overwrite(node.start, node.end, rebuilt);
      },
    });
  };

  const isLabelRead = (node) => {
    if (node.type === "Identifier") return COMPARED_NAMES.test(node.name);
    return (
      (node.type === "MemberExpression" || node.type === "ChainExpression") &&
      !node.computed &&
      ((node.type === "ChainExpression" && isLabelRead(node.expression)) ||
        (node.property?.type === "Identifier" && COMPARED_NAMES.test(node.property.name)))
    );
  };

  const comparedLiteral = (node) => {
    if (node.type !== "Literal" || typeof node.value !== "string") return;
    onString({
      key: node.value,
      kind: "compare",
      replaceOnly: true,
      node,
      replace: (translation) => ms.overwrite(node.start, node.end, JSON.stringify(translation)),
    });
  };

  // String positions: the values an expression can evaluate to without calling anything.
  const stringPositions = (node, kind) => {
    if (!node) return;
    switch (node.type) {
      case "Literal":
        return literal(node, kind);
      case "TemplateLiteral":
        return template(node, kind);
      case "ConditionalExpression":
        stringPositions(node.consequent, kind);
        return stringPositions(node.alternate, kind);
      case "LogicalExpression":
        stringPositions(node.left, kind);
        return stringPositions(node.right, kind);
      case "ParenthesizedExpression":
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
        return stringPositions(node.expression, kind);
      case "ArrayExpression":
        return node.elements.forEach((element) => stringPositions(element, kind));
      default:
        return;
    }
  };

  const returnedValues = (body) => {
    const visit = (node) => {
      if (!node || typeof node.type !== "string") return;
      if (/Function/.test(node.type)) return;
      if (node.type === "ReturnStatement") return copyValue(node.argument);
      for (const key in node) {
        const value = node[key];
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value.type === "string") visit(value);
      }
    };
    visit(body);
  };

  // Every string a copy-named constant holds, including nested objects and what helpers return.
  const copyValue = (node) => {
    if (!node) return;
    switch (node.type) {
      case "ParenthesizedExpression":
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
        return copyValue(node.expression);
      case "ObjectExpression":
        return node.properties.forEach((property) => property.type === "Property" && copyValue(property.value));
      case "ArrowFunctionExpression":
      case "FunctionExpression":
      case "FunctionDeclaration":
        return node.body?.type === "BlockStatement" ? returnedValues(node.body) : copyValue(node.body);
      default:
        return stringPositions(node, "const");
    }
  };

  const walk = (node, parent) => {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "JSXText": {
        const value = decodeEntities(jsxTextValue(node.raw));
        const trimmed = value === null ? "" : value.trim();
        if (trimmed && /[A-Za-z]{2,}/.test(trimmed)) {
          const lead = node.raw.length - node.raw.trimStart().length;
          const trail = node.raw.length - node.raw.trimEnd().length;
          onString({
            key: trimmed,
            kind: "jsx-text",
            node,
            replace: (translation) => {
              const safe = /[{}<>&]/.test(translation) ? `{${JSON.stringify(translation)}}` : translation;
              ms.overwrite(node.start + lead, node.end - trail, safe);
            },
          });
        }
        return;
      }
      case "JSXAttribute": {
        const name = attributeName(node);
        if (name && ATTR_PATTERN.test(name) && node.value) {
          if (node.value.type === "Literal") literal(node.value, "jsx-attr-literal");
          else if (node.value.type === "JSXExpressionContainer") stringPositions(node.value.expression, "jsx-attr");
        }
        if (node.value && node.value.type === "JSXExpressionContainer") walk(node.value.expression, node);
        return;
      }
      case "JSXExpressionContainer": {
        if (parent && (parent.type === "JSXElement" || parent.type === "JSXFragment")) {
          stringPositions(node.expression, "jsx-child");
        }
        break;
      }
      case "Property": {
        const name = propertyKeyName(node);
        if (name && PROP_PATTERN.test(name) && !node.method) stringPositions(node.value, "prop");
        break;
      }
      case "VariableDeclarator": {
        if (node.id.type === "Identifier" && COPY_NAME_PATTERN.test(node.id.name)) copyValue(node.init);
        break;
      }
      case "FunctionDeclaration": {
        if (node.id && COPY_NAME_PATTERN.test(node.id.name)) copyValue(node);
        break;
      }
      case "BinaryExpression": {
        // `item.label === "Commit"` must keep matching once the label itself is translated.
        if (/^[!=]==?$/.test(node.operator)) {
          if (isLabelRead(node.left)) comparedLiteral(node.right);
          else if (isLabelRead(node.right)) comparedLiteral(node.left);
        }
        break;
      }
      case "SwitchStatement": {
        if (isLabelRead(node.discriminant)) {
          node.cases.forEach((switchCase) => switchCase.test && comparedLiteral(switchCase.test));
        }
        break;
      }
      case "CallExpression": {
        const name = memberName(node.callee);
        if (name && (CALL_NAMES.has(name) || CALL_MEMBERS.has(name))) {
          node.arguments.slice(0, 2).forEach((argument) => stringPositions(argument, "call"));
        }
        break;
      }
      case "ImportDeclaration":
      case "ExportAllDeclaration":
      case "TSModuleDeclaration":
      case "TSInterfaceDeclaration":
      case "TSTypeAliasDeclaration":
        return;
      default:
        break;
    }
    for (const key in node) {
      if (key === "type" || key === "start" || key === "end") continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach((child) => walk(child, node));
      else if (value && typeof value.type === "string") walk(value, node);
    }
  };

  walk(parsed.program, null);
  return ms;
}

let dictionaryCache = null;
function loadDictionary() {
  if (dictionaryCache) return dictionaryCache;
  const raw = JSON.parse(fs.readFileSync(DICT_PATH, "utf8"));
  dictionaryCache = new Map(Object.entries(raw).filter(([, value]) => typeof value === "string" && value));
  return dictionaryCache;
}

function isEnabled() {
  return process.env.T3CODE_LOCALE === "zh-Hans";
}

/** Localized source and source map, or null when nothing in the module applies. */
function localizeWithMap(code, file) {
  if (!isEnabled() || !isSourceFile(file)) return null;
  const dictionary = loadDictionary();
  let changed = false;
  const ms = visitModule(code, file, ({ key, replace }) => {
    const translation = dictionary.get(key);
    if (translation === undefined || checkTranslation(key, translation) !== null) return;
    replace(translation);
    changed = true;
  });
  if (!ms || !changed) return null;
  return { code: ms.toString(), map: ms.generateMap({ source: file, includeContent: true, hires: "boundary" }) };
}

/** Returns the localized source, or the input unchanged when nothing applies. */
function localize(code, file) {
  return localizeWithMap(code, file)?.code ?? code;
}

module.exports = {
  ROOT,
  DICT_PATH,
  SOURCE_DIRS,
  isSourceFile,
  visitModule,
  localize,
  localizeWithMap,
  isEnabled,
  checkTranslation,
  __setDictionaryForTest: (map) => {
    dictionaryCache = map;
  },
};
