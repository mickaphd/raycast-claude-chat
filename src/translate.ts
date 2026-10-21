import { LaunchType, getPreferenceValues, getSelectedText, launchCommand } from "@raycast/api";
import { ChatLaunch } from "./lib/storage";

// A no-view command, so it runs (and reads the selection) on every launch: Raycast would just reshow a recent view.
// It opens Ask Claude on a new translation conversation, so the result can be refined by chatting.
export default async function Translate() {
  const { targetLanguage, model, effort } = getPreferenceValues<Preferences.Translate>();
  const instruction = `Translate into ${targetLanguage?.trim() || "French"}:`;
  const text = await getSelectedText().then(
    (selection) => selection.trim(),
    () => "",
  );
  // Without a selection, the instruction is prefilled in the search bar so the text can be typed or pasted.
  const context: ChatLaunch = { kind: "translate", model, effort };
  if (text) context.prompt = `${instruction}\n\n${text}`;
  else context.draft = `${instruction} `;
  await launchCommand({ name: "ask-claude", type: LaunchType.UserInitiated, context });
}
