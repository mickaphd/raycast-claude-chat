import { LocalStorage } from "@raycast/api";
import { randomUUID } from "crypto";

export interface Turn {
  id: string;
  prompt: string;
  answer: string;
  // Markdown shown under the answer when the turn failed or was stopped.
  error?: string;
}

export interface Conversation {
  id: string;
  // Claude Code session used with `--resume` so the CLI keeps the context between turns.
  sessionId?: string;
  // Conversations started by the Translate command get their own icon in the list.
  kind?: "translate";
  turns: Turn[];
}

// What Translate hands to Ask Claude: a message to send (or text to prefill the search bar with) and the model and
// effort to answer it with.
export interface ChatLaunch {
  prompt?: string;
  draft?: string;
  kind?: Conversation["kind"];
  model?: string;
  effort?: string;
}

const STORAGE_KEY = "conversations";

export const newConversation = (firstTurn: Turn, kind?: Conversation["kind"]): Conversation => ({
  id: randomUUID(),
  kind,
  turns: [firstTurn],
});

export const newTurn = (prompt: string): Turn => ({ id: randomUUID(), prompt, answer: "" });

export async function loadConversations(): Promise<Conversation[]> {
  try {
    return JSON.parse((await LocalStorage.getItem<string>(STORAGE_KEY)) ?? "[]");
  } catch {
    return [];
  }
}

export async function saveConversations(conversations: Conversation[]): Promise<void> {
  await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
}
