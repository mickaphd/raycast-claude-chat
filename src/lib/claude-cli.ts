import { spawn } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

// Raycast launches extensions with a minimal PATH, so the CLI must be located explicitly.
const CANDIDATE_PATHS = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude", join(homedir(), ".local/bin/claude")];

const WEB_TOOLS = "WebSearch,WebFetch";

const TOOL_STATUS: Record<string, string> = { WebSearch: "Searching the web…", WebFetch: "Reading a web page…" };

export class ClaudeError extends Error {
  constructor(
    message: string,
    readonly kind: "not-found" | "auth" | "session-not-found" | "aborted" | "other",
  ) {
    super(message);
  }
}

export interface RunOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  effort?: string;
  systemPrompt?: string;
  // Long-lived subscription token from `claude setup-token`; bypasses the Keychain login.
  oauthToken?: string;
  // One-shot commands: no tools, no thinking (much faster) and nothing saved to disk.
  ephemeral?: boolean;
}

export interface RunCallbacks {
  onText: (fullText: string) => void;
  onStatus: (status: string | undefined) => void;
}

// The parts of a Claude Code stream-json event that the chat uses.
interface StreamEvent {
  type?: string;
  content_block?: { type?: string; name?: string };
  delta?: { type?: string; text?: string };
}

export interface RunHandle {
  promise: Promise<{ text: string; sessionId?: string }>;
  abort: () => void;
}

function buildArgs(options: RunOptions): string[] {
  // Plain chat: only web tools (no file/shell), no user/project settings, hooks or MCP servers, and "/foo" is not a skill.
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (options.ephemeral) args.push("--tools", "", "--no-session-persistence");
  else args.push("--tools", WEB_TOOLS, "--allowedTools", WEB_TOOLS);
  args.push("--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands");
  // An empty string still replaces Claude Code's own (coding agent) system prompt.
  if (options.systemPrompt !== undefined) args.push("--system-prompt", options.systemPrompt);
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.sessionId) args.push("--resume", options.sessionId);
  return args;
}

function buildEnv(claudePath: string, options: RunOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dirname(claudePath)}:${process.env.PATH}`,
    // One request per message: no telemetry, error reporting, update checks or claude.ai connector lookups.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  };
  // Force the CLI onto the subscription, talking to Anthropic only: no API key, no custom endpoint.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  if (options.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = options.oauthToken;
  if (options.ephemeral) env.MAX_THINKING_TOKENS = "0";
  return env;
}

function classifyError(message: string): ClaudeError["kind"] {
  if (/no conversation found/i.test(message)) return "session-not-found";
  if (/\/login|not logged in|authenticat|oauth/i.test(message)) return "auth";
  return "other";
}

export function runClaude(options: RunOptions, callbacks: Partial<RunCallbacks> = {}): RunHandle {
  let abort = () => {};

  const promise = new Promise<{ text: string; sessionId?: string }>((resolve, reject) => {
    const claudePath = CANDIDATE_PATHS.find((p) => existsSync(p));
    if (!claudePath) throw new ClaudeError("Claude Code CLI not found", "not-found");
    const child = spawn(claudePath, buildArgs(options), {
      cwd: options.cwd,
      env: buildEnv(claudePath, options),
    });
    let aborted = false;
    abort = () => {
      aborted = child.exitCode === null;
      child.kill();
    };

    let text = "";
    let sessionId: string | undefined;
    let result: { isError: boolean; text: string } | undefined;
    let limitMessage: string | undefined;
    let buffer = "";
    let stderr = "";

    const handleEvent = (event: Record<string, unknown>) => {
      if (typeof event.session_id === "string") sessionId = event.session_id;
      if (event.type === "stream_event" && !event.parent_tool_use_id) {
        const { type, content_block: block, delta } = (event.event ?? {}) as StreamEvent;
        if (type === "content_block_start") {
          // Text blocks split by tool calls are separated by a paragraph break.
          if (block?.type === "text" && text && !text.endsWith("\n\n")) text += text.endsWith("\n") ? "\n" : "\n\n";
          callbacks.onStatus?.(block?.type === "thinking" ? "Thinking…" : TOOL_STATUS[block?.name ?? ""]);
        } else if (delta?.type === "text_delta" && delta.text) {
          text += delta.text;
          callbacks.onText?.(text);
        }
      } else if (event.type === "rate_limit_event") {
        const info = event.rate_limit_info as { status?: string; resetsAt?: number } | undefined;
        if (info?.status !== "rejected") return;
        const time = info.resetsAt
          ? ` It resets at ${new Date(info.resetsAt * 1000).toLocaleTimeString([], { timeStyle: "short" })}.`
          : "";
        limitMessage = `You've reached your Claude usage limit.${time}`;
      } else if (event.type === "result") {
        const errors = Array.isArray(event.errors) ? event.errors.join("\n") : "";
        result = { isError: event.is_error === true, text: typeof event.result === "string" ? event.result : errors };
      }
    };

    const handleLine = (line: string) => {
      try {
        handleEvent(JSON.parse(line));
      } catch {
        // Blank or non-JSON lines (warnings) are not part of the conversation.
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const lines = (buffer + chunk).split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(handleLine);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.on("error", () => {}); // The CLI may exit before reading stdin; "close" reports why.
    child.stdin.end(options.prompt);

    child.on("error", reject);
    child.on("close", (code) => {
      handleLine(buffer);
      callbacks.onStatus?.(undefined);
      if (aborted) return reject(new ClaudeError("Stopped", "aborted"));
      // Prefer the streamed text (keeps paragraph breaks between tool calls) over the summary result.
      if (result && !result.isError) return resolve({ text: text || result.text, sessionId });
      if (limitMessage) return reject(new ClaudeError(limitMessage, "other"));
      const message = (result?.text || stderr || `Claude exited with code ${code}`).trim();
      reject(new ClaudeError(message, classifyError(message)));
    });
  });

  return { promise, abort: () => abort() };
}
