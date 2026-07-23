/**
 * Parse human-friendly durations ("30s", "5m", "1h", "1500ms") or a bare
 * millisecond integer ("30000") into milliseconds.
 *
 * Kept dependency-free on purpose (no `ms` package) — this is the entire
 * surface area we need, and it's easier to trust three lines of regex than
 * to trust a transitive dependency's edge cases.
 */
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
};

export function parseDuration(input: string): number {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/i.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid duration "${input}". Use a plain millisecond integer or a suffixed value like "30s", "5m", "1h".`
    );
  }

  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  return Math.round(value * UNIT_MS[unit]);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
