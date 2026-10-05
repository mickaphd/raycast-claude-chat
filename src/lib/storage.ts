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
  turns: Turn[];
  updatedAt: number;
}

const STORAGE_KEY = "conversations";

export const newConversation = (): Conversation => ({ id: randomUUID(), turns: [], updatedAt: Date.now() });

export const newTurn = (prompt: string): Turn => ({ id: randomUUID(), prompt, answer: "" });

export async function loadConversations(): Promise<Conversation[]> {
  try {
    return JSON.parse((await LocalStorage.getItem<string>(STORAGE_KEY)) ?? "[]");
  } catch {
    return [];
  }
}

export async function saveConversations(conversations: Conversation[]): Promise<void> {
  // The empty draft conversation is a placeholder for the next prompt, not history.
  await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(conversations.filter((c) => c.turns.length > 0)));
}
