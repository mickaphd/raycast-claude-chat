import { Clipboard, Toast, environment, getPreferenceValues, getSelectedText, showHUD, showToast } from "@raycast/api";
import { setTimeout as sleep } from "timers/promises";
import { ClaudeError, runClaude } from "./lib/claude-cli";

const TIMEOUT_MS = 15_000;

// Raycast's own "Fix Spelling and Grammar" AI command prompt, verbatim.
const PROMPT = `Act as a spelling corrector and improver. Reply only with the rewritten text and nothing else.

Strictly follow these rules:
- Correct spelling, grammar and punctuation
- ALWAYS detect and maintain the original language of the given text
- NEVER surround the rewritten text with quotes
- Don't replace urls with markdown links
- Don't change emojis

Text to rewrite:
{selection}

Rewritten text:`;

export default async function FixGrammar() {
  const preferences = getPreferenceValues<Preferences.FixGrammar>();
  let selection: string;
  try {
    selection = await getSelectedText();
  } catch {
    return showHUD("No text selected");
  }
  // Selections often carry surrounding whitespace or a trailing newline: keep them out of the model's hands.
  const [, before, text, after] = selection.match(/^(\s*)([\s\S]*?)(\s*)$/) ?? [];
  if (!text) return showHUD("No text selected");

  await showToast({ style: Toast.Style.Animated, title: "Fixing…" });
  const run = runClaude({
    prompt: PROMPT.replace("{selection}", () => text),
    cwd: environment.supportPath,
    model: preferences.model,
    systemPrompt: "",
    oauthToken: preferences.oauthToken?.replace(/\s+/g, ""),
    ephemeral: true,
  });
  // Without a deadline, a stalled network would leave "Fixing…" on screen forever.
  const timer = setTimeout(run.abort, TIMEOUT_MS);
  try {
    const { text: output } = await run.promise;
    const fixed = output.trim();
    if (fixed === text) return showHUD("No mistakes found");

    // Pasting goes through the clipboard: restore what was there once the paste has landed.
    const previous = await Clipboard.read();
    await Clipboard.paste(before + fixed + after);
    await sleep(500);
    await Clipboard.copy(previous);
    await showHUD("Fixed");
  } catch (error) {
    await showHUD(failureMessage(error, Boolean(preferences.oauthToken?.trim())));
  } finally {
    clearTimeout(timer);
  }
}

function failureMessage(error: unknown, hasToken: boolean): string {
  if (error instanceof ClaudeError && error.kind === "aborted")
    return `Fix timed out after ${TIMEOUT_MS / 1000} seconds`;
  if (error instanceof ClaudeError && error.kind === "auth") {
    return hasToken
      ? "Claude rejected the OAuth token: create a new one with claude setup-token"
      : "Set the OAuth Token in the extension preferences";
  }
  return `Fix failed: ${error instanceof Error ? error.message : String(error)}`;
}
