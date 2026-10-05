import { Clipboard, Toast, environment, getPreferenceValues, getSelectedText, showHUD, showToast } from "@raycast/api";
import { setTimeout } from "timers/promises";
import { runClaude } from "./lib/claude-cli";

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
  try {
    const { text: output } = await runClaude({
      prompt: PROMPT.replace("{selection}", () => text),
      cwd: environment.supportPath,
      model: preferences.model,
      systemPrompt: "",
      oauthToken: preferences.oauthToken?.replace(/\s+/g, ""),
      ephemeral: true,
    }).promise;
    const fixed = output.trim();
    if (fixed === text) return showHUD("No mistakes found");

    // Pasting goes through the clipboard: restore what was there once the paste has landed.
    const previous = await Clipboard.read();
    await Clipboard.paste(before + fixed + after);
    await setTimeout(500);
    await Clipboard.copy(previous);
    await showHUD("Fixed");
  } catch (error) {
    await showHUD(`Fix failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
