// Mobile UI for conversation translation. zh/metro.cjs serves this file as the module
// "t3code:zh-translation-mobile" and resolves its imports as if it sat at
// apps/mobile/src/__zh__/translation.tsx. Uniwind only generates classes it finds under apps/mobile,
// so every class used here must already appear there (translation.test.cjs checks that).
// Settings live in the desktop and web composer; here a thread can only be switched on or off.
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Alert, Pressable, View } from "react-native";

import { ComposerInlineControl } from "../components/ComposerToolbar";
import { AppText as Text } from "../components/ui/AppText";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../state/atom-registry";

// Must match RPC_METHOD in translation-transform.cjs.
const RPC_METHOD = "server.zhTranslation";

interface ThreadTranslationState {
  configured: boolean;
  config: { userLanguage: string; agentLanguage: string; translateInput: boolean };
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

// Per-thread state and translation results, shared by every row. Read through
// useSyncExternalStore: React Compiler memoizes a render that reads the maps directly.
const threadStates = new Map<string, ThreadTranslationState>();
const threadLoads = new Set<string>();
const RESULT_CACHE_MAX = 500;
const results = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
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

function remember(key: string, value: string): void {
  results.delete(key);
  results.set(key, value);
  while (results.size > RESULT_CACHE_MAX) results.delete(results.keys().next().value as string);
}

type DisplayTranslation =
  | { status: "idle" | "pending"; retry: () => void }
  | { status: "done"; text: string; retry: () => void }
  | { status: "error"; error: string; retry: () => void };

function useDisplayTranslation(environmentId: string | undefined, text: string, enabled: boolean): DisplayTranslation {
  const key = `${environmentId}\nagent-to-user\n${text}`;
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
      request = call<{ text: string }>(environmentId, "translate", { direction: "agent-to-user", text })
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
  }, [environmentId, text, key, enabled, failed, cached, attempt]);

  if (!enabled) return { status: "idle", retry };
  if (cached !== undefined) return { status: "done", text: cached, retry };
  if (failed) return { status: "error", error: failure.error, retry };
  return { status: "pending", retry };
}

/** The translation once it differs from the original; equal text was already in the user's language. */
function shownTranslation(translation: DisplayTranslation, text: string): string | undefined {
  return translation.status === "done" && translation.text.trim() !== text.trim() ? translation.text : undefined;
}

/**
 * Wraps a finished assistant message or a plan card: the translation replaces the original, with a
 * toggle back. The wrapper is always rendered so the markdown is not remounted when a stream ends.
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
  const translation = useDisplayTranslation(props.environmentId, props.text, active);
  const [showOriginal, setShowOriginal] = useState(false);
  const translated = shownTranslation(translation, props.text);

  return (
    <View>
      {props.children(translated !== undefined && !showOriginal ? translated : props.text)}
      {translation.status === "pending" ? <Text className="mt-1 text-xs text-foreground-muted">翻译中…</Text> : null}
      {translation.status === "error" ? (
        <View className="mt-1 flex-row items-center gap-2">
          <Text className="shrink text-xs text-danger-foreground">翻译失败：{translation.error}</Text>
          <Pressable accessibilityRole="button" hitSlop={8} onPress={translation.retry}>
            <Text className="text-xs text-foreground-secondary">重试</Text>
          </Pressable>
        </View>
      ) : null}
      {translated !== undefined ? (
        <View className="mt-1 flex-row items-center gap-2">
          <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setShowOriginal((value) => !value)}>
            <Text className="text-xs text-foreground-secondary">{showOriginal ? "显示译文" : "显示原文"}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/** Agent-written text with its translation swapped in once it arrives; the original until then. */
export function useAgentText(text: string, environmentId: string | undefined, threadId: string | undefined): string {
  const thread = useThreadTranslation(environmentId, threadId);
  const active = thread?.configured === true && thread.threadEnabled;
  return shownTranslation(useDisplayTranslation(environmentId, text, active), text) ?? text;
}

/** One inline piece of a pending question: its header, an option, or an option's description. */
export function QuestionText(props: { text: string; environmentId: string | undefined; threadId: string | undefined }) {
  return useAgentText(props.text, props.environmentId, props.threadId);
}

/** Composer control that switches translation for this thread. */
export function ComposerTranslationToggle(props: {
  environmentId: string | undefined;
  threadId: string | undefined;
  size: "regular" | "large";
}) {
  const state = useThreadTranslation(props.environmentId, props.threadId);
  const environmentId = props.environmentId;
  const threadId = props.threadId;
  if (!state || !environmentId || !threadId) return null;
  const on = state.configured && state.threadEnabled;

  const setEnabled = (enabled: boolean) => {
    call<ThreadTranslationState>(environmentId, "setThread", { threadId, enabled }).then(
      (next) => {
        threadStates.set(`${environmentId}\n${threadId}`, next);
        emit();
      },
      (error: unknown) => Alert.alert("无法切换翻译", messageOf(error)),
    );
  };
  const open = () => {
    if (!state.configured) {
      Alert.alert("对话翻译", "还没有设置翻译接口。请在电脑端输入框的「译」按钮里填写接口地址与模型。");
      return;
    }
    const { userLanguage, agentLanguage, translateInput } = state.config;
    const effect = `回复显示为${userLanguage}${translateInput ? `，你的消息先译成 ${agentLanguage} 再发给 Agent` : ""}。`;
    Alert.alert("对话翻译", on ? `此会话已开启翻译：${effect}` : `开启后，${effect}`, [
      { text: "取消", style: "cancel" },
      { text: on ? "关闭翻译" : "开启翻译", onPress: () => setEnabled(!on) },
    ]);
  };

  return (
    <ComposerInlineControl
      size={props.size}
      label={on ? "翻译已开启" : "翻译"}
      iconOnly
      showChevron={false}
      selected={on}
      onPress={open}
      renderIcon={() => (
        <Text className={on ? "font-t3-bold text-sm text-primary" : "font-t3-bold text-sm text-foreground-muted"}>译</Text>
      )}
    />
  );
}
