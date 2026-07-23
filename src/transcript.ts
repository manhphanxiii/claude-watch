/**
 * Transcript parsing.
 *
 * Detectors need structure, not raw bytes. Claude Code's headless mode can
 * emit `--output-format stream-json`: one JSON object per line, mirroring
 * the Messages API shape (assistant/user messages whose `content` arrays
 * hold `text`, `tool_use`, and `tool_result` blocks), plus a final `result`
 * summary entry.
 *
 * That JSONL schema is NOT a documented, versioned public contract — the
 * CTO diligence flags this explicitly as the biggest technical risk. We
 * parse defensively: unrecognized shapes are kept as `unknown` entries and
 * simply don't match any detector rule, rather than throwing. When Claude
 * Code's transcript format shifts, expect to update the `*_KEYS` constants
 * below and bump the affected detector's `version`, not rewrite this file.
 */

export type ToolUseBlock = {
  type: "tool_use";
  name: string;
  input?: unknown;
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
};

export type TextBlock = {
  type: "text";
  text: string;
};

export type ContentBlock = ToolUseBlock | ToolResultBlock | TextBlock | { type: string; [k: string]: unknown };

export type TranscriptEntry =
  | { type: "assistant"; message: { content: ContentBlock[] } }
  | { type: "user"; message: { content: ContentBlock[] } }
  | { type: "result"; subtype?: string; result?: string; is_error?: boolean }
  | { type: string; [k: string]: unknown };

/**
 * Parse raw stdout captured from the wrapped process into transcript
 * entries. Only used when `--transcript-format stream-json` is set; plain
 * `text` mode (the default, since most users pipe `claude -p` without a
 * structured output flag) returns an empty entry list and detectors become
 * a documented no-op — the idle/wall-clock timeout still fully applies.
 */
export function parseTranscript(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
        entries.push(parsed as TranscriptEntry);
      }
    } catch {
      // Non-JSON line in a stream-json stream — ignore rather than abort.
      // (Claude Code interleaves the occasional log line on some versions.)
    }
  }
  return entries;
}

export function allContentBlocks(entries: TranscriptEntry[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const entry of entries) {
    if ((entry.type === "assistant" || entry.type === "user") && "message" in entry) {
      const message = (entry as { message?: { content?: ContentBlock[] } }).message;
      if (message?.content) blocks.push(...message.content);
    }
  }
  return blocks;
}

export function toolUseBlocks(entries: TranscriptEntry[]): ToolUseBlock[] {
  return allContentBlocks(entries).filter((b): b is ToolUseBlock => b.type === "tool_use");
}

export function toolResultBlocks(entries: TranscriptEntry[]): ToolResultBlock[] {
  return allContentBlocks(entries).filter((b): b is ToolResultBlock => b.type === "tool_result");
}

export function textOf(block: ToolResultBlock["content"]): string {
  if (!block) return "";
  if (typeof block === "string") return block;
  return block
    .map((c) => (typeof c === "object" && "text" in c ? c.text ?? "" : ""))
    .join("\n");
}

/** Final assistant-visible text: last `result` entry, else last assistant text block. */
export function finalText(entries: TranscriptEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "result" && "result" in entry && typeof entry.result === "string") {
      return entry.result;
    }
  }
  const blocks = allContentBlocks(entries);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.type === "text" && "text" in block) return (block as TextBlock).text;
  }
  return "";
}
