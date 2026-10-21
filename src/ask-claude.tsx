import {
  Action,
  ActionPanel,
  Alert,
  Clipboard,
  Color,
  Icon,
  Keyboard,
  LaunchProps,
  List,
  Toast,
  confirmAlert,
  environment,
  getPreferenceValues,
  openExtensionPreferences,
  showHUD,
  showToast,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { ClaudeError, RunHandle, runClaude } from "./lib/claude-cli";
import { conversationTitle, conversationToMarkdown, threadMarkdown, transcriptPrompt } from "./lib/markdown";
import {
  ChatLaunch,
  Conversation,
  Turn,
  loadConversations,
  newConversation,
  newTurn,
  saveConversations,
} from "./lib/storage";

const SYSTEM_PROMPT =
  "You are Claude, a helpful AI assistant made by Anthropic. The user is chatting with you from Raycast, a macOS launcher. " +
  "Format answers in Markdown. Be clear and reasonably concise. Reply in the language the user writes in. " +
  "When asked to translate a text, reply with the translation only, unless asked for more.";

const RENDER_THROTTLE_MS = 80;
// How long after creating a conversation a selection reported by Raycast is treated as its own, not the user's.
const PIN_MS = 1000;

const WELCOME =
  "## New conversation\n\n" +
  "Type your message in the search bar and press **↵**. Select a conversation on the left to keep chatting in it.\n\n" +
  "**⌘N** new conversation · **⌘.** stop · **⌘⇧C** copy the conversation · **⌃X** delete it · **⌘K** all actions";

const INSTALL_HELP = "## Claude Code CLI not found\n\nInstall it with `brew install --cask claude-code`.";

const AUTH_HELP =
  "## Claude Code can't sign in\n\n" +
  "1. In Terminal, run `claude setup-token` and approve access with your **Claude Pro/Max** account.\n" +
  "2. Copy the **whole** token it prints (`sk-ant-oat01-…`, about 100 characters).\n" +
  "3. Paste it in the **OAuth Token** preference (⌘⇧,), then press **⌘R** to retry.";

// Claude has no clock; the local date and time zone let it answer "what time is it in…" questions.
function currentContext(): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date().toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short", timeZone });
  return `The user's local date and time when this conversation started: ${now} (${timeZone}).`;
}

// "" means Claude Code's default model, which the CLI doesn't name up front.
const modelName = (model: string) => model.charAt(0).toUpperCase() + model.slice(1);

// The fixed "New Conversation" item: sending from it creates a conversation and selects it.
const NEW_ID = "new";

function errorMarkdown(error: unknown, hasToken: boolean): string {
  if (!(error instanceof ClaudeError)) return `**Error**\n\n\`\`\`\n${String(error)}\n\`\`\``;
  if (error.kind === "not-found") return INSTALL_HELP;
  if (error.kind === "aborted") return "_Stopped_";
  // A missing token and a rejected one need different fixes; the CLI's own words follow for diagnosis.
  const tokenState = hasToken ? "A token is set but Claude rejected it." : "No token is set in the preferences.";
  const help = error.kind === "auth" ? `${AUTH_HELP}\n\n${tokenState} Claude Code said:` : "**Error**";
  return `${help}\n\n\`\`\`\n${error.message}\n\`\`\``;
}

export default function AskClaude(props: LaunchProps<{ launchContext?: ChatLaunch }>) {
  const preferences = getPreferenceValues<Preferences.AskClaude>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // Not passed to List as isLoading: Raycast ignores selection changes made while loading. Loading takes milliseconds.
  const [isLoaded, setIsLoaded] = useState(false);
  const [currentId, setCurrentId] = useState(NEW_ID);
  const [searchText, setSearchText] = useState("");
  const [streamingTurnId, setStreamingTurnId] = useState<string>();
  const [status, setStatus] = useState<string>();
  const runRef = useRef<RunHandle>(undefined);
  // Translate's launch (kind, model, effort), applied to the next conversation created, typed or sent at launch.
  const pendingLaunch = useRef(props.launchContext);
  // A conversation just created and selected by code, and until when Raycast may still override that selection.
  const pinned = useRef<{ id: string; until: number }>(undefined);
  const latest = useRef(conversations);
  latest.current = conversations;

  const current = conversations.find((c) => c.id === currentId);

  useEffect(() => {
    // Always open on "New Conversation": earlier ones are one arrow key away.
    loadConversations().then((stored) => {
      setConversations(stored);
      setIsLoaded(true);
    });
    return () => {
      runRef.current?.abort();
      // Saving normally waits for the answer to end; closing the chat mid-answer (e.g. a new Translate) mustn't lose it.
      if (latest.current.length > 0) saveConversations(latest.current);
    };
  }, []);

  // Send the launch message (from Translate or a fallback search) once the history is loaded.
  useEffect(() => {
    if (!isLoaded) return;
    const prompt = props.launchContext?.prompt ?? props.fallbackText?.trim();
    if (prompt) send(prompt);
    else if (props.launchContext?.draft) setSearchText(props.launchContext.draft);
  }, [isLoaded]);

  // Persist outside of streaming: saving on every token would be wasteful.
  useEffect(() => {
    if (isLoaded && !streamingTurnId) saveConversations(conversations);
  }, [conversations, isLoaded, streamingTurnId]);

  function update(conversationId: string, change: (c: Conversation) => Partial<Conversation>) {
    setConversations((list) => list.map((c) => (c.id === conversationId ? { ...c, ...change(c) } : c)));
  }

  function updateTurn(conversationId: string, turnId: string, change: Partial<Turn>) {
    update(conversationId, (c) => ({ turns: c.turns.map((t) => (t.id === turnId ? { ...t, ...change } : t)) }));
  }

  // Without a conversation (from "New Conversation"), the message starts a new one.
  async function send(prompt: string, existing?: Conversation, retryTurnId?: string) {
    if (runRef.current) {
      await showToast({ style: Toast.Style.Failure, title: "Claude is still answering", message: "Stop it with ⌘." });
      return;
    }
    const turn = newTurn(prompt);
    const previousTurns = existing?.turns.filter((t) => t.id !== retryTurnId) ?? [];
    const launch = existing ? undefined : pendingLaunch.current;
    if (!existing) pendingLaunch.current = undefined;
    const conversation = existing ?? newConversation(turn, launch?.kind);
    if (existing) {
      update(conversation.id, () => ({ turns: [...previousTurns, turn] }));
    } else {
      // Newest first; replies don't reorder, so the list never shifts under the selection.
      setConversations((list) => [conversation, ...list]);
      setCurrentId(conversation.id);
      pinned.current = { id: conversation.id, until: Date.now() + PIN_MS };
    }
    setSearchText("");
    setStreamingTurnId(turn.id);
    // Raycast's native spinner, also used to show what Claude is doing (thinking, searching the web…).
    const answering = "Claude is answering…";
    const toast = showToast({ style: Toast.Style.Animated, title: answering });

    let pendingText: string | undefined;
    let flushTimer: NodeJS.Timeout | undefined;
    const flush = () => {
      clearTimeout(flushTimer);
      flushTimer = undefined;
      if (pendingText !== undefined) updateTurn(conversation.id, turn.id, { answer: pendingText });
      pendingText = undefined;
    };

    const start = (sessionId: string | undefined, text: string) => {
      runRef.current = runClaude(
        {
          prompt: text,
          cwd: environment.supportPath,
          sessionId,
          model: launch?.model ?? preferences.model,
          effort: launch?.effort ?? preferences.effort,
          systemPrompt: `${SYSTEM_PROMPT}\n\n${currentContext()}`,
          // Terminals often insert spaces or line breaks when copying the wrapped token.
          oauthToken: preferences.oauthToken?.replace(/\s+/g, ""),
        },
        {
          onText: (fullText) => {
            pendingText = fullText;
            flushTimer ??= setTimeout(flush, RENDER_THROTTLE_MS);
          },
          onStatus: (next) => {
            setStatus(next);
            toast.then((t) => (t.title = next ?? answering));
          },
        },
      );
      return runRef.current.promise;
    };

    try {
      const result = await start(conversation.sessionId, prompt).catch((error) => {
        if (error instanceof ClaudeError && error.kind === "session-not-found") {
          return start(undefined, transcriptPrompt(previousTurns, prompt));
        }
        throw error;
      });
      pendingText = undefined;
      flush();
      updateTurn(conversation.id, turn.id, { answer: result.text });
      update(conversation.id, (c) => ({ sessionId: result.sessionId ?? c.sessionId }));
    } catch (error) {
      flush();
      updateTurn(conversation.id, turn.id, { error: errorMarkdown(error, Boolean(preferences.oauthToken?.trim())) });
    } finally {
      toast.then((t) => t.hide());
      runRef.current = undefined;
      setStreamingTurnId(undefined);
      setStatus(undefined);
    }
  }

  function deleteConversations(ids: string[]) {
    const streaming = conversations.find((c) => c.turns.some((t) => t.id === streamingTurnId));
    if (streaming && ids.includes(streaming.id)) runRef.current?.abort();
    setConversations((list) => list.filter((c) => !ids.includes(c.id)));
    if (ids.includes(currentId)) setCurrentId(NEW_ID);
  }

  function actions(conversation?: Conversation) {
    const lastTurn = conversation?.turns.at(-1);
    const isIdle = lastTurn?.id !== streamingTurnId;
    const prompt = searchText.trim();
    return (
      <ActionPanel>
        {prompt && <Action title="Send to Claude" icon={Icon.ArrowUp} onAction={() => send(prompt, conversation)} />}
        {streamingTurnId && (
          <Action
            title="Stop Generating"
            icon={Icon.Stop}
            style={Action.Style.Destructive}
            // ⌘. is the macOS convention for cancelling.
            // eslint-disable-next-line @raycast/prefer-common-shortcut
            shortcut={{ modifiers: ["cmd"], key: "." }}
            onAction={() => runRef.current?.abort()}
          />
        )}
        {lastTurn?.answer && isIdle && (
          <>
            <Action.CopyToClipboard title="Copy Last Answer" content={lastTurn.answer} />
            <Action.Paste
              title="Paste Last Answer"
              content={lastTurn.answer}
              shortcut={{ modifiers: ["cmd", "shift"], key: "v" }}
            />
          </>
        )}
        {lastTurn?.error && isIdle && (
          <Action
            title="Retry"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={() => send(lastTurn.prompt, conversation, lastTurn.id)}
          />
        )}
        <ActionPanel.Section>
          <Action
            title="New Conversation"
            icon={Icon.PlusCircle}
            shortcut={Keyboard.Shortcut.Common.New}
            onAction={() => setCurrentId(NEW_ID)}
          />
          {conversation && (
            <>
              <Action
                title="Copy Conversation"
                icon={Icon.CopyClipboard}
                shortcut={Keyboard.Shortcut.Common.Copy}
                onAction={async () => {
                  await Clipboard.copy(conversationToMarkdown(conversation));
                  await showHUD("Copied to Clipboard");
                }}
              />
              <Action
                title="Delete Conversation"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                shortcut={Keyboard.Shortcut.Common.Remove}
                onAction={() => deleteConversations([conversation.id])}
              />
            </>
          )}
          {conversations.length > 0 && (
            <Action
              title="Delete All Conversations"
              icon={Icon.Trash}
              style={Action.Style.Destructive}
              shortcut={Keyboard.Shortcut.Common.RemoveAll}
              onAction={async () => {
                const confirmed = await confirmAlert({
                  title: "Delete all conversations?",
                  primaryAction: { title: "Delete All", style: Alert.ActionStyle.Destructive },
                });
                if (confirmed) deleteConversations(conversations.map((c) => c.id));
              }}
            />
          )}
        </ActionPanel.Section>
        <Action
          title="Open Extension Preferences"
          icon={Icon.Gear}
          shortcut={{ modifiers: ["cmd", "shift"], key: "," }}
          onAction={openExtensionPreferences}
        />
      </ActionPanel>
    );
  }

  function icon(conversation: Conversation) {
    const lastTurn = conversation.turns.at(-1);
    const isTranslation = conversation.kind === "translate";
    if (lastTurn?.id === streamingTurnId) {
      return { source: isTranslation ? Icon.Globe : Icon.SpeechBubbleActive, tintColor: Color.Orange };
    }
    if (lastTurn?.error && !lastTurn.answer) return { source: Icon.ExclamationMark, tintColor: Color.Red };
    return isTranslation ? Icon.Globe : Icon.Bubble;
  }

  return (
    <List
      filtering={false}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder={current ? "Reply to this conversation…" : "Ask Claude anything…"}
      navigationTitle={["Claude", modelName(preferences.model)].filter(Boolean).join(" · ")}
      isShowingDetail
      selectedItemId={currentId}
      onSelectionChange={(id) => {
        if (!id) return;
        setCurrentId(id);
        // When a conversation is created without the search text changing (Translate), Raycast keeps its previous
        // selection and reports it. Asking again, once the list has settled, makes it select the new conversation.
        const pin = pinned.current;
        pinned.current = undefined;
        if (pin && id !== pin.id && Date.now() < pin.until) setTimeout(() => setCurrentId(pin.id), 50);
      }}
    >
      <List.Item
        id={NEW_ID}
        title="New Conversation"
        icon={{ source: Icon.PlusCircle, tintColor: Color.Orange }}
        detail={<List.Item.Detail markdown={WELCOME} />}
        actions={actions()}
      />
      <List.Section title="Conversations">
        {conversations.map((conversation) => (
          <List.Item
            key={conversation.id}
            id={conversation.id}
            title={conversationTitle(conversation)}
            icon={icon(conversation)}
            detail={<List.Item.Detail markdown={threadMarkdown(conversation, streamingTurnId, status)} />}
            actions={actions(conversation)}
          />
        ))}
      </List.Section>
    </List>
  );
}
