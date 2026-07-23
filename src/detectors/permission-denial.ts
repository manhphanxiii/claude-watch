import { Detector, DetectorConfig, DetectorResult } from "./types";
import { TranscriptEntry, allContentBlocks, textOf, ContentBlock, ToolResultBlock } from "../transcript";

/**
 * v1 heuristic for GitHub issue patterns like #40751 ("silent failures" from
 * background-agent permission checks) and the general shape reported across
 * the anthropics/claude-code "stall"/"silent" issue search (see
 * docs/research/2026-07-24-second-product-discovery.md §5).
 *
 * Trips when:
 *   1. a tool_result block's content matches a denial pattern, AND
 *   2. at least one more tool_use happens afterward (execution continued
 *      instead of stopping), AND
 *   3. nothing in the rest of the transcript surfaces that as an error to
 *      the user (no `result.is_error`, no acknowledgement text like
 *      "permission was denied" / "I cannot continue").
 *
 * This is intentionally a plain regex pass over JSON, not a stateful parser
 * of Claude Code's internal permission engine — the CTO diligence doc flags
 * transcript-format drift as the main risk, so keep the rule readable and
 * override-able rather than clever.
 */

const DEFAULT_DENIAL_PATTERNS = [
  "permission denied",
  "permission.*denied",
  "not allowed to",
  "blocked by permission",
  "requires approval",
  "requires user approval",
  "denied by user",
  "declined the",
  "tool use was denied",
  "not permitted",
];

const ACKNOWLEDGEMENT_PATTERNS = [
  "permission was denied",
  "permission.*denied.*so i",
  "i cannot continue",
  "i('m| am) unable to (continue|proceed)",
  "i'll stop here",
  "i will stop here",
  "aborting",
  "cannot proceed without",
  "i don't have permission",
];

function buildRegexes(patterns: string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p, "i"));
}

function resolvePatterns(config: DetectorConfig | undefined, fallback: string[]): string[] {
  if (config?.patterns) return config.patterns;
  if (config?.extraPatterns) return [...fallback, ...config.extraPatterns];
  return fallback;
}

export const permissionDenialDetector: Detector = {
  id: "permission-denial",
  version: 1,
  description:
    "Flags a denied/blocked tool permission followed by continued execution with no surfaced error.",
  run(entries: TranscriptEntry[], config?: DetectorConfig): DetectorResult {
    const denialPatterns = buildRegexes(resolvePatterns(config, DEFAULT_DENIAL_PATTERNS));
    const ackPatterns = buildRegexes(ACKNOWLEDGEMENT_PATTERNS);

    const blocks: ContentBlock[] = allContentBlocks(entries);

    let denialIndex = -1;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.type !== "tool_result") continue;
      const text = textOf((block as ToolResultBlock).content);
      if (denialPatterns.some((re) => re.test(text))) {
        denialIndex = i;
        break;
      }
    }

    if (denialIndex === -1) {
      return { tripped: false, reason: "permission-denial-without-error", detail: "No permission-denial pattern found in tool_result blocks." };
    }

    const continuedExecution = blocks.slice(denialIndex + 1).some((b) => b.type === "tool_use");
    if (!continuedExecution) {
      return {
        tripped: false,
        reason: "permission-denial-without-error",
        detail: "Permission denial found, but no further tool_use followed — the run stopped, which is the expected behavior.",
      };
    }

    const hasResultError = entries.some(
      (e) => e.type === "result" && "is_error" in e && (e as { is_error?: boolean }).is_error === true
    );
    const trailingText = blocks
      .slice(denialIndex + 1)
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const acknowledged = ackPatterns.some((re) => re.test(trailingText));

    if (hasResultError || acknowledged) {
      return {
        tripped: false,
        reason: "permission-denial-without-error",
        detail: "Permission denial found, but the run surfaced it as an error/acknowledgement to the user.",
      };
    }

    return {
      tripped: true,
      reason: "permission-denial-without-error",
      detail:
        "A tool permission was denied and execution continued afterward with no surfaced error or acknowledgement — the run may look successful while having silently skipped work.",
    };
  },
};
