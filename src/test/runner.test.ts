import { test } from "node:test";
import assert from "node:assert/strict";
import { runSupervised } from "../runner";

// These exercise the real process-wrapper path against `sh -c '...'` fixtures —
// per the task's self-verification note, we don't need a real `claude -p` call
// to prove idle/wall-clock timeout and exit-code plumbing; a sleep/echo-based
// shell fixture exercises the exact same cross-spawn + timer + kill-signal path.

test("idle-timeout trips when the command produces no output for long enough", async () => {
  const result = await runSupervised({
    command: ["sh", "-c", "sleep 5"],
    idleTimeoutMs: 300,
    gracePeriodMs: 200,
    transcriptFormat: "text",
    detectorIds: [],
    pollIntervalMs: 50,
  });
  assert.equal(result.reason, "idle-timeout");
  assert.equal(result.exitCode, 1);
  assert.ok(result.durationMs < 3000, `expected early kill, took ${result.durationMs}ms`);
});

test("max-duration trips even when the command keeps producing output", async () => {
  const result = await runSupervised({
    command: ["sh", "-c", "i=0; while [ $i -lt 100 ]; do echo hi; sleep 0.05; i=$((i+1)); done"],
    maxDurationMs: 300,
    gracePeriodMs: 200,
    transcriptFormat: "text",
    detectorIds: [],
    pollIntervalMs: 50,
  });
  assert.equal(result.reason, "max-duration");
  assert.equal(result.exitCode, 2);
  assert.ok(result.durationMs < 3000, `expected early kill, took ${result.durationMs}ms`);
});

test("a clean, fast command exits 0 with no failure reason", async () => {
  const result = await runSupervised({
    command: ["sh", "-c", "echo hello"],
    gracePeriodMs: 200,
    transcriptFormat: "text",
    detectorIds: [],
  });
  assert.equal(result.reason, undefined);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello/);
});

test("a command that exits non-zero on its own propagates that exit code", async () => {
  const result = await runSupervised({
    command: ["sh", "-c", "exit 7"],
    gracePeriodMs: 200,
    transcriptFormat: "text",
    detectorIds: [],
  });
  assert.equal(result.reason, "child-exit-nonzero");
  assert.equal(result.exitCode, 7);
});

test("stream-json transcript mode trips the false-completion detector on a real spawned process", async () => {
  const transcript = JSON.stringify({
    type: "result",
    subtype: "success",
    result: "All done! Successfully completed the task.",
    is_error: false,
  });
  const result = await runSupervised({
    command: ["sh", "-c", `echo '${transcript}'`],
    gracePeriodMs: 200,
    transcriptFormat: "stream-json",
    detectorIds: ["false-completion"],
  });
  assert.equal(result.reason, "false-completion");
  assert.equal(result.exitCode, 4);
});
