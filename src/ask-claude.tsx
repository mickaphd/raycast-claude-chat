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
import { Conversation, Turn, loadConversations, newConversation, newTurn, saveConversations } from "./lib/storage";

const DEFAULT_SYSTEM_PROMPT =
  "You are Claude, a helpful AI assistant made by Anthropic. The user is chatting with you from Raycast, a macOS launcher. " +
  "Format answers in Markdown. Be clear and reasonably concise. Reply in the language the user writes in.";

const RENDER_THROTTLE_MS = 80;

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

function errorMarkdown(error: unknown): string {
  if (!(error instanceof ClaudeError)) return `**Error**\n\n\`\`\`\n${String(error)}\n\`\`\``;
  if (error.kind === "not-found") return INSTALL_HELP;
  if (error.kind === "aborted") return "_Stopped_";
  // Keep the CLI's own words so a misdetected error is still diagnosable.
  const help = error.kind === "auth" ? `${AUTH_HELP}\n\nClaude Code said:` : "**Error**";
  return `${help}\n\n\`\`\`\n${error.message}\n\`\`\``;
}

export default function AskClaude(props: LaunchProps) {
  const preferences = getPreferenceValues<Preferences.AskClaude>();
  // The list always holds exactly one empty "draft" conversation, shown as "New Conversation".
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentId, setCurrentId] = useState<string>();
  const [searchText, setSearchText] = useState("");
  const [streamingTurnId, setStreamingTurnId] = useState<string>();
  const [status, setStatus] = useState<string>();
  const runRef = useRef<RunHandle>(undefined);

  const draft = conversations.find((c) => c.turns.length === 0);
  const history = conversations.filter((c) => c.turns.length > 0).sort((a, b) => b.updatedAt - a.updatedAt);
  const current = conversations.find((c) => c.id === currentId);
  const isLoaded = draft !== undefined;

  useEffect(() => {
    // Always open on "New Conversation": earlier ones are one arrow key away.
    loadConversations().then((stored) => {
      const newDraft = newConversation();
      const fallback = props.fallbackText?.trim();
      setConversations([newDraft, ...stored]);
      setCurrentId(newDraft.id);
      if (fallback) send(fallback, newDraft);
    });
    return () => runRef.current?.abort();
  }, []);

  // Persist outside of streaming: saving on every token would be wasteful.
  useEffect(() => {
    if (isLoaded && !streamingTurnId) saveConversations(conversations);
  }, [conversations, isLoaded, streamingTurnId]);

  function update(conversationId: string, change: (c: Conversation) => Partial<Conversation>) {
    setConversations((list) => {
      const updated = list.map((c) => (c.id === conversationId ? { ...c, ...change(c) } : c));
      // Once the draft receives its first message, a fresh draft takes its place.
      return updated.some((c) => c.turns.length === 0) ? updated : [newConversation(), ...updated];
    });
  }

  function updateTurn(conversationId: string, turnId: string, change: Partial<Turn>) {
    update(conversationId, (c) => ({ turns: c.turns.map((t) => (t.id === turnId ? { ...t, ...change } : t)) }));
  }

  async function send(prompt: string, conversation: Conversation, retryTurnId?: string) {
    if (runRef.current) {
      await showToast({ style: Toast.Style.Failure, title: "Claude is still answering", message: "Stop it with ⌘." });
      return;
    }
    const previousTurns = conversation.turns.filter((t) => t.id !== retryTurnId);
    const turn = newTurn(prompt);
    update(conversation.id, () => ({ turns: [...previousTurns, turn], updatedAt: Date.now() }));
    setSearchText("");
    setStreamingTurnId(turn.id);

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
          model: preferences.model,
          effort: preferences.effort,
          systemPrompt: `${preferences.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT}\n\n${currentContext()}`,
          // Terminals often insert spaces or line breaks when copying the wrapped token.
          oauthToken: preferences.oauthToken?.replace(/\s+/g, ""),
        },
        {
          onText: (fullText) => {
            pendingText = fullText;
            flushTimer ??= setTimeout(flush, RENDER_THROTTLE_MS);
          },
          onStatus: setStatus,
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
      update(conversation.id, (c) => ({ sessionId: result.sessionId ?? c.sessionId, updatedAt: Date.now() }));
    } catch (error) {
      flush();
      updateTurn(conversation.id, turn.id, { error: errorMarkdown(error) });
    } finally {
      runRef.current = undefined;
      setStreamingTurnId(undefined);
      setStatus(undefined);
    }
  }

  function deleteConversations(ids: string[]) {
    const streaming = conversations.find((c) => c.turns.some((t) => t.id === streamingTurnId));
    if (streaming && ids.includes(streaming.id)) runRef.current?.abort();
    setConversations((list) => list.filter((c) => !ids.includes(c.id)));
    if (currentId && ids.includes(currentId)) setCurrentId(draft?.id);
  }

  function actions(conversation: Conversation) {
    const lastTurn = conversation.turns.at(-1);
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
            onAction={() => setCurrentId(draft?.id)}
          />
          {lastTurn && (
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
          {history.length > 0 && (
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
                if (confirmed) deleteConversations(history.map((c) => c.id));
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
    if (lastTurn?.id === streamingTurnId) return { source: Icon.CircleProgress, tintColor: Color.Orange };
    if (lastTurn?.error && !lastTurn.answer) return { source: Icon.ExclamationMark, tintColor: Color.Red };
    return Icon.Bubble;
  }

  return (
    <List
      isLoading={!isLoaded || streamingTurnId !== undefined}
      filtering={false}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder={current?.turns.length ? "Reply to this conversation…" : "Ask Claude anything…"}
      navigationTitle={status ? `Claude · ${status}` : "Claude"}
      isShowingDetail
      selectedItemId={currentId}
      onSelectionChange={(id) => id && setCurrentId(id)}
    >
      {draft && (
        <List.Item
          id={draft.id}
          title="New Conversation"
          icon={{ source: Icon.PlusCircle, tintColor: Color.Orange }}
          detail={<List.Item.Detail markdown={WELCOME} />}
          actions={actions(draft)}
        />
      )}
      <List.Section title="Conversations">
        {history.map((conversation) => (
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
