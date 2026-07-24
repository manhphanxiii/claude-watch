import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { execFileSync } from "child_process";
import { runSupervised } from "../runner";

const FIXTURES = path.join(__dirname, "..", "..", "fixtures");

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

// Regression test for a shipped bug: permission-denial.ts returned a reason
// string ("permission-denial-without-error") that didn't match the
// FailureReason union, so exitCodeForReason() silently fell through and the
// process exited 0 on a genuine permission-denial trip, even though stderr
// and --json both reported failure. A unit-level test on the detector alone
// (asserting `.tripped`) can't catch this — it has to go through the real
// runner/exit-code plumbing against the real fixture, per the documented
// exit code contract (README: 3 = permission-denial).
test("permission-denial fixture trips through the real runner with the documented exit code 3", async () => {
  const fixturePath = path.join(FIXTURES, "permission-denial-trip.json");
  const result = await runSupervised({
    command: [
      "node",
      "-e",
      `require(${JSON.stringify(fixturePath)}).forEach((e) => console.log(JSON.stringify(e)));`,
    ],
    gracePeriodMs: 200,
    transcriptFormat: "stream-json",
    detectorIds: ["permission-denial"],
  });
  assert.equal(result.reason, "permission-denial");
  assert.equal(result.exitCode, 3);
});

// Regression test for a shipped bug: trip() only killed the direct spawned
// pid (`child.kill(signal)`). A command that forks its own children (a shell
// chain, a backgrounded job — realistic since this wraps `claude -p`, whose
// Bash tool does exactly that) left those children as orphans holding the
// stdout pipe open. Fixed by spawning `detached: true` and killing the whole
// process group (`process.kill(-child.pid, signal)`) instead.
//
// `(sleep N &)` backgrounds a distinctive sleep duration inside a subshell
// that immediately exits — the backgrounded `sleep` reparents (becomes an
// orphan of init/launchd) but, absent job control, keeps the *same process
// group* as the wrapper shell: exactly the scenario a pid-only kill misses
// and a group kill catches.
//
// IMPORTANT on the shape of this assertion: checking "no matching process
// after runSupervised() resolves" is NOT sufficient on its own — Node's
// `close` event (which the returned promise waits on) cannot fire until
// every process holding the stdout pipe's write end has exited, including
// the orphan. So an unpatched, pid-only kill doesn't make the assertion
// fail; it just makes the *promise itself* not resolve until the orphan
// finishes sleeping on its own — silently defeating the whole point of the
// idle-timeout (verified manually: reverting the fix to plain
// `child.kill(signal)` made this exact test "pass" after ~137s instead of
// failing, because by the time the check ran the orphan had already exited
// naturally). The real, bug-catching assertion is therefore on *elapsed
// time*: the run must resolve close to its idle-timeout + grace-period
// budget, not hang for the orphan's full sleep duration. The post-resolve
// process-table check is kept as a secondary confirmation, not the
// load-bearing one.
test(
  "trip() kills the whole process group so a backgrounded grandchild doesn't hang the run past its timeout",
  { skip: process.platform === "win32" ? "process-group kill is POSIX-specific" : false },
  async () => {
    const marker = "6"; // seconds — long enough to still be alive if group-kill fails, short enough to keep a failing test fast

    function countMatchingProcesses(): number {
      try {
        const out = execFileSync("pgrep", ["-f", `sleep ${marker}`], { encoding: "utf8" });
        return out.split("\n").filter((line) => line.trim().length > 0).length;
      } catch {
        // pgrep exits 1 (no matches) — that's the success case here.
        return 0;
      }
    }

    // Sanity: nothing matching our marker should be running before the test
    // (guards against flakiness/collision from a previous failed run).
    assert.equal(countMatchingProcesses(), 0, "test precondition: no stray marker process should be running yet");

    try {
      const startedAt = Date.now();
      const result = await runSupervised({
        command: ["sh", "-c", `(sleep ${marker} &) ; sleep ${marker}`],
        idleTimeoutMs: 200,
        gracePeriodMs: 300,
        transcriptFormat: "text",
        detectorIds: [],
        pollIntervalMs: 50,
      });
      const elapsedMs = Date.now() - startedAt;

      assert.equal(result.reason, "idle-timeout");
      // Budget: idleTimeoutMs (200) + gracePeriodMs (300) + generous slack
      // for CI scheduling jitter. A pid-only kill would instead block until
      // the ${marker}s orphan exits on its own (~${marker}000ms).
      assert.ok(
        elapsedMs < 3000,
        `expected the group kill to let the run resolve near its timeout+grace budget, took ${elapsedMs}ms — ` +
          `an orphaned grandchild holding the stdout pipe open would hang this past its own configured timeout`
      );

      // Secondary confirmation: the orphaned grandchild should also actually
      // be dead (not just detached from the resolved promise).
      assert.equal(
        countMatchingProcesses(),
        0,
        "expected no orphaned descendant process to survive the trip — process-group kill should have caught the backgrounded child too"
      );
    } finally {
      // Best-effort cleanup so a failing assertion above doesn't leak a
      // sleep process into the rest of the test run / CI machine.
      try {
        execFileSync("pkill", ["-f", `sleep ${marker}`]);
      } catch {
        // Nothing to clean up — fine.
      }
    }
  }
);
