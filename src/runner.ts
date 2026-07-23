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

export function runSupervised(options: RunOptions): Promise<RunResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const [cmd, ...args] = options.command;
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"] });
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
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
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
