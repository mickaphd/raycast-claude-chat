import { Conversation, Turn } from "./storage";

export const conversationTitle = (conversation: Conversation) => conversation.turns[0].prompt.replace(/\s+/g, " ");

// Conversations are immutable, so an unchanged one keeps its rendered thread across renders.
const threadCache = new WeakMap<Conversation, string>();

// Newest exchange first: Raycast always shows the top of the detail pane and can't scroll to the bottom.
export function threadMarkdown(conversation: Conversation, streamingTurnId?: string, status?: string): string {
  const isStreaming = conversation.turns.some((t) => t.id === streamingTurnId);
  const cached = isStreaming ? undefined : threadCache.get(conversation);
  if (cached) return cached;
  const markdown = conversation.turns
    .toReversed()
    .map((turn) => {
      const question = turn.prompt.replace(/^/gm, "> ");
      const placeholder = turn.id === streamingTurnId ? `_${status ?? "Claude is thinking…"}_` : "";
      return [question, turn.answer || placeholder, turn.error].filter(Boolean).join("\n\n");
    })
    .join("\n\n---\n\n");
  if (!isStreaming) threadCache.set(conversation, markdown);
  return markdown;
}

export function conversationToMarkdown(conversation: Conversation): string {
  return conversation.turns.map((t) => `**You:** ${t.prompt}\n\n**Claude:** ${t.answer}`).join("\n\n---\n\n");
}

// Used when the CLI session is gone (Claude Code deletes old sessions): replay the history as plain text.
export function transcriptPrompt(turns: Turn[], prompt: string): string {
  const history = turns
    .filter((t) => t.answer)
    .map((t) => `<user>\n${t.prompt}\n</user>\n<assistant>\n${t.answer}\n</assistant>`)
    .join("\n");
  if (!history) return prompt;
  return `Here is our conversation so far:\n<conversation>\n${history}\n</conversation>\n\nContinue it by replying to my new message:\n\n${prompt}`;
}
