// Web UI for conversation translation. zhLocalePlugin serves this file as the virtual module
// "t3code:zh-translation-web" at apps/web/src/__zh__/translation.tsx, so its relative imports
// resolve inside the web app. Tailwind only scans files under apps/web, so every class used here
// must already appear in upstream sources (translation.test.cjs checks that).
// Display logic is derived from AgentDeck's translated-text.tsx.
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { LanguagesIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

// Must match RPC_METHOD in translation-transform.cjs.
const RPC_METHOD = "server.zhTranslation";

type Direction = "user-to-agent" | "agent-to-user";
type Protocol = "chat-completions" | "responses" | "anthropic";

interface TranslationConfig {
  baseUrl: string;
  model: string;
  protocol: Protocol;
  apiKeySet: boolean;
  requestUrl: string;
  userLanguage: string;
  agentLanguage: string;
  translateInput: boolean;
  enabledByDefault: boolean;
}

interface ThreadTranslationState {
  configured: boolean;
  config: TranslationConfig;
  threadEnabled: boolean;
}

const translationCommand = createEnvironmentRpcCommand(connectionAtomRuntime as never, {
  label: "zh:translation",
  tag: RPC_METHOD as never,
});

async function call<T>(environmentId: string, op: string, input: Record<string, unknown>): Promise<T> {
  const result: any = await runAtomCommand(
    appAtomRegistry,
    translationCommand as never,
    { environmentId, input: { op, input } } as never,
    { reportFailure: false },
  );
  if (result._tag !== "Success") throw new Error("无法连接翻译服务");
  if (result.value?.ok !== true) throw new Error(result.value?.error ?? "翻译服务返回了无效的响应");
  return result.value.value as T;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------------------
// Per-thread state, shared by every row of a thread. A missing entry is fetched on first use.

const threadStates = new Map<string, ThreadTranslationState>();
const threadLoads = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  for (const listener of listeners) listener();
}

function useThreadTranslation(
  environmentId: string | undefined,
  threadId: string | undefined,
): ThreadTranslationState | undefined {
  const key = environmentId && threadId ? `${environmentId}\n${threadId}` : null;
  const state = useSyncExternalStore(subscribe, () => (key ? threadStates.get(key) : undefined));
  useEffect(() => {
    if (!key || !environmentId || state !== undefined || threadLoads.has(key)) return;
    threadLoads.add(key);
    call<ThreadTranslationState>(environmentId, "state", { threadId })
      .then((loaded) => {
        threadStates.set(key, loaded);
        emit();
      })
      // An environment without the overlay has no such RPC; the UI then stays hidden.
      .catch(() => undefined)
      .finally(() => threadLoads.delete(key));
  }, [key, environmentId, threadId, state]);
  return state;
}

/** Stores a fresh state for one thread; other threads of the environment refetch when a setting changed. */
function applyThreadState(
  environmentId: string,
  threadId: string,
  next: ThreadTranslationState,
  settingsChanged: boolean,
): void {
  if (settingsChanged) {
    for (const key of [...threadStates.keys()]) {
      if (key.startsWith(`${environmentId}\n`)) threadStates.delete(key);
    }
    results.clear();
  }
  threadStates.set(`${environmentId}\n${threadId}`, next);
  emit();
}

// ---------------------------------------------------------------------------------------------
// Translation results. The server keeps a disk cache; this one avoids repeat requests in a page.

const RESULT_CACHE_MAX = 500;
const results = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function remember(key: string, value: string): void {
  results.delete(key);
  results.set(key, value);
  while (results.size > RESULT_CACHE_MAX) results.delete(results.keys().next().value as string);
}

type DisplayTranslation =
  | { status: "idle" | "pending"; retry: () => void }
  | { status: "done"; text: string; retry: () => void }
  | { status: "error"; error: string; retry: () => void };

function useDisplayTranslation(
  environmentId: string | undefined,
  text: string,
  direction: Direction,
  enabled: boolean,
): DisplayTranslation {
  const key = `${environmentId}\n${direction}\n${text}`;
  // Read through the store hook: React Compiler memoizes a render that reads the map directly.
  const cached = useSyncExternalStore(subscribe, () => results.get(key));
  const [failure, setFailure] = useState<{ key: string; error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = () => {
    setFailure(null);
    setAttempt((value) => value + 1);
  };
  const failed = failure?.key === key;

  useEffect(() => {
    // After a failure only "retry" asks again.
    if (!enabled || !environmentId || failed || cached !== undefined) return;
    let cancelled = false;
    let request = inflight.get(key);
    if (!request) {
      request = call<{ text: string }>(environmentId, "translate", { direction, text })
        .then((translated) => {
          remember(key, translated.text);
          emit();
          return translated.text;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, request);
    }
    request.catch((error: unknown) => {
      if (!cancelled) setFailure({ key, error: messageOf(error) });
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, direction, text, key, enabled, failed, cached, attempt]);

  if (!enabled) return { status: "idle", retry };
  if (cached !== undefined) return { status: "done", text: cached, retry };
  if (failed) return { status: "error", error: failure.error, retry };
  return { status: "pending", retry };
}

/**
 * True once the element has come within 200px of the viewport, and it stays true. Only visible
 * content is translated, so opening a long thread does not translate its whole history.
 */
function useSeenOnce(): [(node: Element | null) => void, boolean] {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  const observerRef = useRef<IntersectionObserver | null>(null);
  const ref = useCallback(
    (node: Element | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!node || seen) return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer.disconnect();
            setSeen(true);
          }
        },
        { rootMargin: "200px 0px" },
      );
      observer.observe(node);
      observerRef.current = observer;
    },
    [seen],
  );
  useEffect(() => () => observerRef.current?.disconnect(), []);
  return [ref, seen];
}

const BAR_CLASS = "mt-1 flex items-center gap-2 text-xs text-muted-foreground";
const LINK_CLASS = "cursor-pointer text-xs text-muted-foreground underline-offset-4 hover:underline";
const STATUS_INFO_CLASS = "whitespace-pre-wrap break-words text-xs text-muted-foreground";
const STATUS_ERROR_CLASS = "whitespace-pre-wrap break-words text-xs text-destructive";

/**
 * Wraps a finished assistant message or a plan card: once visible it is translated and the translation replaces
 * the original, with a toggle back. The wrapper element is always rendered so the markdown below
 * it is not remounted when translation turns on or a stream ends.
 */
export function AssistantTranslation(props: {
  text: string;
  streaming: boolean;
  environmentId: string | undefined;
  threadId: string | undefined;
  children: (text: string) => ReactNode;
}) {
  const thread = useThreadTranslation(props.environmentId, props.threadId);
  const active = thread?.configured === true && thread.threadEnabled && !props.streaming;
  const [ref, seen] = useSeenOnce();
  const translation = useDisplayTranslation(props.environmentId, props.text, "agent-to-user", active && seen);
  const [showOriginal, setShowOriginal] = useState(false);
  // A translation equal to the original means the text was already in the user's language.
  const translated =
    translation.status === "done" && translation.text.trim() !== props.text.trim() ? translation.text : undefined;

  return (
    <div ref={ref}>
      {props.children(translated !== undefined && !showOriginal ? translated : props.text)}
      {translation.status === "pending" ? <div className={BAR_CLASS}>翻译中…</div> : null}
      {translation.status === "error" ? (
        <div className={BAR_CLASS}>
          <span className="text-destructive">翻译失败：{translation.error}</span>
          <button type="button" className={LINK_CLASS} onClick={translation.retry}>
            重试
          </button>
        </div>
      ) : null}
      {translated !== undefined ? (
        <div className={BAR_CLASS}>
          <button type="button" className={LINK_CLASS} onClick={() => setShowOriginal((value) => !value)}>
            {showOriginal ? "显示译文" : "显示原文"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One piece of a pending question: its header, text, or an option. Shows the translation once it
 * arrives and the original on hover; while pending or after a failure the original stays.
 * With children it wraps a markdown renderer, otherwise it renders inline text.
 */
export function QuestionText(props: {
  text: string;
  environmentId: string | undefined;
  threadId: string | undefined;
  children?: (text: string) => ReactNode;
}) {
  const thread = useThreadTranslation(props.environmentId, props.threadId);
  const active = thread?.configured === true && thread.threadEnabled;
  const translation = useDisplayTranslation(props.environmentId, props.text, "agent-to-user", active);
  const translated =
    translation.status === "done" && translation.text.trim() !== props.text.trim() ? translation.text : undefined;
  if (props.children) {
    return <div title={translated === undefined ? undefined : props.text}>{props.children(translated ?? props.text)}</div>;
  }
  return translated === undefined ? props.text : <span title={props.text}>{translated}</span>;
}

type SentRecord = { text?: string; error?: string } | null;

/** Under a user message: what the agent actually received, fetched on demand. */
export function SentTranslation(props: {
  environmentId: string | undefined;
  threadId: string | undefined;
  messageId: string;
}) {
  const thread = useThreadTranslation(props.environmentId, props.threadId);
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<{ value: SentRecord } | { error: string } | null>(null);
  const environmentId = props.environmentId;
  if (!environmentId || thread?.configured !== true || !thread.threadEnabled || !thread.config.translateInput) {
    return null;
  }
  const toggle = () => {
    setOpen(!open);
    if (open) return;
    // Asked again on every open: the translation is recorded when the turn starts, after the message shows up.
    setRecord(null);
    call<SentRecord>(environmentId, "sent", { messageId: props.messageId }).then(
      (value) => setRecord({ value }),
      (error: unknown) => setRecord({ error: messageOf(error) }),
    );
  };
  return (
    <div className="mt-1 flex flex-col items-end gap-1">
      <button type="button" className={LINK_CLASS} onClick={toggle}>
        {open ? "收起译文" : "查看发送的译文"}
      </button>
      {open ? (
        <div className="max-w-full whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {record === null
            ? "读取中…"
            : "error" in record
              ? `读取失败：${record.error}`
              : record.value === null
                ? "没有译文记录：这条消息按原文发送，或尚未发送给 Agent。"
                : record.value.error !== undefined
                  ? `翻译失败，已按原文发送：${record.value.error}`
                  : record.value.text}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Composer toggle and settings

const PROTOCOL_OPTIONS: ReadonlyArray<{ value: Protocol; label: string; hint: string }> = [
  { value: "chat-completions", label: "OpenAI Chat Completions", hint: "请求 <地址>/chat/completions" },
  { value: "responses", label: "OpenAI Responses", hint: "请求 <地址>/responses" },
  { value: "anthropic", label: "Anthropic Messages", hint: "请求 <地址>/v1/messages" },
];

const SAMPLE_TEXT = "你好，世界。Hello, world.";

interface SettingsDraft {
  baseUrl: string;
  model: string;
  protocol: Protocol;
  apiKey: string;
  userLanguage: string;
  agentLanguage: string;
  translateInput: boolean;
  enabledByDefault: boolean;
}

function draftOf(config: TranslationConfig): SettingsDraft {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    protocol: config.protocol,
    apiKey: "",
    userLanguage: config.userLanguage,
    agentLanguage: config.agentLanguage,
    translateInput: config.translateInput,
    enabledByDefault: config.enabledByDefault,
  };
}

/** The changed fields only; an empty API key field means "keep the stored key". */
function patchOf(draft: SettingsDraft, config: TranslationConfig): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(draft) as Array<keyof SettingsDraft>) {
    if (key === "apiKey") {
      if (draft.apiKey.trim().length > 0) patch.apiKey = draft.apiKey.trim();
    } else if (draft[key] !== config[key]) {
      patch[key] = draft[key];
    }
  }
  return patch;
}

function Field(props: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{props.label}</span>
      {props.children}
    </label>
  );
}

function SwitchRow(props: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm">{props.label}</span>
      <Switch
        size="sm"
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={(checked) => props.onChange(Boolean(checked))}
        aria-label={props.label}
      />
    </div>
  );
}

function TranslationPanel(props: { environmentId: string; threadId: string; state: ThreadTranslationState }) {
  const { environmentId, threadId, state } = props;
  const [draft, setDraft] = useState(() => draftOf(state.config));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const patch = patchOf(draft, state.config);
  const dirty = Object.keys(patch).length > 0;
  const update = (next: Partial<SettingsDraft>) => setDraft((current) => ({ ...current, ...next }));

  const run = (work: () => Promise<string | null>) => {
    setBusy(true);
    setStatus(null);
    work()
      .then((text) => setStatus(text === null ? null : { tone: "info", text }))
      .catch((error: unknown) => setStatus({ tone: "error", text: messageOf(error) }))
      .finally(() => setBusy(false));
  };
  const save = async () => {
    const next = await call<ThreadTranslationState>(environmentId, "setConfig", { threadId, patch });
    applyThreadState(environmentId, threadId, next, true);
    setDraft(draftOf(next.config));
  };

  return (
    <div className="flex flex-col gap-3">
      <SwitchRow
        label="翻译此会话"
        checked={state.threadEnabled}
        disabled={busy || !state.configured}
        onChange={(enabled) =>
          run(async () => {
            const next = await call<ThreadTranslationState>(environmentId, "setThread", { threadId, enabled });
            applyThreadState(environmentId, threadId, next, false);
            return null;
          })
        }
      />
      <div className="text-xs text-muted-foreground">
        {state.configured
          ? `开启后，回复显示为${state.config.userLanguage}${state.config.translateInput ? `，你的消息先译成 ${state.config.agentLanguage} 再发给 Agent` : ""}。`
          : "先在下方填写翻译接口的地址与模型并保存。"}
      </div>
      <div className="border-t border-border" />
      <Field label="接口协议">
        <Select value={draft.protocol} onValueChange={(value) => update({ protocol: value as Protocol })}>
          <SelectTrigger size="sm" aria-label="接口协议">
            <SelectValue>{PROTOCOL_OPTIONS.find((option) => option.value === draft.protocol)?.label}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {PROTOCOL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>
      <Field label={`接口地址（${PROTOCOL_OPTIONS.find((option) => option.value === draft.protocol)?.hint}）`}>
        <Input
          size="sm"
          value={draft.baseUrl}
          onChange={(event) => update({ baseUrl: event.target.value })}
          placeholder="https://api.deepseek.com/v1"
          spellCheck={false}
        />
      </Field>
      <Field label="模型">
        <Input
          size="sm"
          value={draft.model}
          onChange={(event) => update({ model: event.target.value })}
          placeholder="deepseek-chat"
          spellCheck={false}
        />
      </Field>
      <Field label="API Key">
        <Input
          size="sm"
          type="password"
          value={draft.apiKey}
          onChange={(event) => update({ apiKey: event.target.value })}
          placeholder={state.config.apiKeySet ? "已保存，留空则不修改" : "未设置"}
          autoComplete="off"
        />
      </Field>
      <div className="flex items-center gap-2">
        <Field label="我的语言">
          <Input size="sm" value={draft.userLanguage} onChange={(event) => update({ userLanguage: event.target.value })} />
        </Field>
        <Field label="Agent 语言">
          <Input size="sm" value={draft.agentLanguage} onChange={(event) => update({ agentLanguage: event.target.value })} />
        </Field>
      </div>
      <SwitchRow
        label="翻译我发送的消息"
        checked={draft.translateInput}
        onChange={(translateInput) => update({ translateInput })}
      />
      <SwitchRow
        label="新会话默认开启"
        checked={draft.enabledByDefault}
        onChange={(enabledByDefault) => update({ enabledByDefault })}
      />
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={busy || dirty || !state.configured}
          onClick={() =>
            run(async () => {
              const result = await call<{ text: string }>(environmentId, "translate", {
                direction: "user-to-agent",
                text: SAMPLE_TEXT,
                fresh: true,
              });
              return `测试通过：${result.text}`;
            })
          }
        >
          测试
        </Button>
        <Button
          type="button"
          size="xs"
          disabled={busy || !dirty}
          onClick={() =>
            run(async () => {
              await save();
              return "已保存";
            })
          }
        >
          保存
        </Button>
      </div>
      {status ? (
        <div className={status.tone === "error" ? STATUS_ERROR_CLASS : STATUS_INFO_CLASS}>{status.text}</div>
      ) : null}
    </div>
  );
}

/** Composer footer button: the per-thread switch and the environment's translation settings. */
export function ComposerTranslationToggle(props: { environmentId: string | undefined; threadId: string | undefined }) {
  const state = useThreadTranslation(props.environmentId, props.threadId);
  if (!state || !props.environmentId || !props.threadId) return null;
  const on = state.configured && state.threadEnabled;
  const label = on ? "翻译已开启" : "翻译";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            title={label}
            className="relative shrink-0"
          />
        }
      >
        <LanguagesIcon style={on ? { color: "var(--primary)" } : undefined} />
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" width="md">
        <TranslationPanel environmentId={props.environmentId} threadId={props.threadId} state={state} />
      </PopoverPopup>
    </Popover>
  );
}
