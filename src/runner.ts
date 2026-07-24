import spawn from "cross-spawn";
import { ChildProcess } from "child_process";
import { runDetectors } from "./detectors";
import { parseTranscript } from "./transcript";
import { EXIT_OK, EXIT_IDLE_TIMEOUT, EXIT_MAX_DURATION, FailureReason, exitCodeForReason } from "./exit-codes";
import { formatDuration } from "./duration";

export interface RunOptions {
  command: string[];
  idleTimeoutMs?: number;
  maxDurationMs?: number;
  gracePeriodMs: number;
  transcriptFormat: "text" | "stream-json";
  detectorIds: string[];
  /** Called with each raw chunk of combined stdout, e.g. to echo it live. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Poll interval for the idle-timeout check. Exposed for fast tests. */
  pollIntervalMs?: number;
}

export interface RunResult {
  exitCode: number;
  reason?: FailureReason;
  detail?: string;
  durationMs: number;
  stdout: string;
}

/**
 * Kill the whole process group the child was spawned into, not just the
 * direct child pid. `child.kill(signal)` only signals the one spawned pid;
 * any process it forks (a shell chain, `cmd &` backgrounded job) becomes an
 * orphan that keeps the stdout pipe fd open, so the `close` event
 * `runSupervised`'s Promise depends on may never fire.
 *
 * Standard Unix pattern: spawn with `detached: true` so the child's pid is
 * also its process group id (pgid), then signal the negative pid to target
 * the whole group instead of a single process. No `tree-kill`-style
 * dependency needed.
 *
 * Windows has no process-group signals in this sense, so we fall back to
 * plain `child.kill()` there (and `cross-spawn`'s Windows path already uses
 * `taskkill /T` semantics are out of scope here — this fix targets the
 * POSIX orphan case described in the bug report).
 */
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (err) {
    // ESRCH: group already gone (e.g. everything already exited) — fine.
    // Anything else: fall back to signaling just the direct child so we
    // still make a best effort rather than throwing out of a kill path.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      try {
        child.kill(signal);
      } catch {
        // Nothing left to signal; ignore.
      }
    }
  }
}

export function runSupervised(options: RunOptions): Promise<RunResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const [cmd, ...args] = options.command;
    let child: ChildProcess;
    try {
      // `detached: true` puts the child in its own process group (its pid
      // becomes the group's pgid on POSIX). Combined with killProcessGroup()
      // below, this lets us kill the whole tree the wrapped command spawns
      // (shell chains, backgrounded jobs — realistic since this wraps
      // `claude -p`, whose Bash tool does exactly that), not just the direct
      // child. Without it, orphaned grandchildren keep the stdout pipe open
      // and the `close` event this Promise depends on never fires — i.e.
      // claude-watch hangs past its own timeout on the very failure mode
      // (hangs) it exists to catch.
      child = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"], detached: true });
    } catch (err) {
      resolve({
        exitCode: exitCodeForReason("child-exit-nonzero"),
        reason: "child-exit-nonzero",
        detail: `Failed to spawn command: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startedAt,
        stdout: "",
      });
      return;
    }

    let stdout = "";
    let lastActivity = Date.now();
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let trippedReason: FailureReason | undefined;
    let trippedDetail: string | undefined;

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      stdout += text;
      lastActivity = Date.now();
      options.onStdout?.(text);
    });
    child.stderr?.on("data", (data: Buffer) => {
      options.onStderr?.(data.toString("utf8"));
    });

    function trip(reason: FailureReason, detail: string) {
      if (trippedReason) return; // already tripping
      trippedReason = reason;
      trippedDetail = detail;
      killProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) killProcessGroup(child, "SIGKILL");
      }, options.gracePeriodMs);
    }

    const idlePoll = options.idleTimeoutMs
      ? setInterval(() => {
          if (Date.now() - lastActivity >= options.idleTimeoutMs!) {
            trip(
              "idle-timeout",
              `No stdout activity for ${formatDuration(options.idleTimeoutMs!)} (idle-timeout). Sent SIGTERM, will SIGKILL after ${formatDuration(
                options.gracePeriodMs
              )} grace period if still running.`
            );
          }
        }, pollIntervalMs)
      : undefined;

    const maxDurationTimer = options.maxDurationMs
      ? setTimeout(() => {
          trip(
            "max-duration",
            `Wall-clock ceiling of ${formatDuration(options.maxDurationMs!)} (max-duration) exceeded. Sent SIGTERM, will SIGKILL after ${formatDuration(
              options.gracePeriodMs
            )} grace period if still running.`
          );
        }, options.maxDurationMs)
      : undefined;

    child.on("close", (code, signal) => {
      settled = true;
      if (idlePoll) clearInterval(idlePoll);
      if (maxDurationTimer) clearTimeout(maxDurationTimer);
      if (killTimer) clearTimeout(killTimer);

      const durationMs = Date.now() - startedAt;

      if (trippedReason) {
        resolve({
          exitCode: exitCodeForReason(trippedReason),
          reason: trippedReason,
          detail: trippedDetail,
          durationMs,
          stdout,
        });
        return;
      }

      // Not a timeout — run silent-failure detectors against the transcript
      // (if we have one) before trusting a clean/zero exit.
      if (options.transcriptFormat === "stream-json" && options.detectorIds.length > 0) {
        const entries = parseTranscript(stdout);
        const outcomes = runDetectors(entries, options.detectorIds);
        const tripped = outcomes.find((o) => o.result.tripped);
        if (tripped) {
          resolve({
            exitCode: exitCodeForReason(tripped.result.reason as FailureReason),
            reason: tripped.result.reason as FailureReason,
            detail: tripped.result.detail,
            durationMs,
            stdout,
          });
          return;
        }
      }

      if (code !== 0 && code !== null) {
        resolve({
          exitCode: code,
          reason: "child-exit-nonzero",
          detail: `Wrapped command exited with code ${code}${signal ? ` (signal ${signal})` : ""}.`,
          durationMs,
          stdout,
        });
        return;
      }

      resolve({ exitCode: EXIT_OK, durationMs, stdout });
    });
  });
}

export { EXIT_IDLE_TIMEOUT, EXIT_MAX_DURATION };
