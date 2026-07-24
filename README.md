# claude-watch

A reliability supervisor for **unattended** Claude Code / Claude Agent SDK runs — cron jobs, CI pipelines, GitHub Actions, Anthropic's own Routines. Nobody is watching the terminal, so `claude-watch` watches it for you: it wraps your headless invocation, kills it if it hangs, catches two documented silent-failure patterns, and fires a webhook or Slack alert the moment something goes wrong.

Free. MIT-licensed. No account, no server, no database, no dashboard — a single process that spawns your command, watches it, and exits.

If Claude Code is hanging in CI, stalling in a cron job, or silently claiming success without doing the work, see [**Claude Code Hangs in CI or Cron? Here's Why, and How to Catch It Automatically**](./docs/claude-code-hangs-in-ci-cron.md) for a symptom-by-symptom walkthrough (idle timeout, wall-clock timeout, silent permission denial, false completion claims) with copy-pasteable fixes for GitHub Actions and cron.

## Why this exists

When Claude Code runs with nobody watching, three things can go wrong and nothing tells you:

1. **It hangs.** The process sits there, burning wall-clock time (and sometimes tokens) with no forward progress.
2. **A tool permission gets silently denied, and the agent keeps going anyway** — instead of stopping or surfacing an error, it carries on as if nothing happened, and the run *looks* successful.
3. **It claims "done" without having done anything.** The final message reports success; the transcript shows no tool calls that could have produced it.

These aren't hypothetical. They're actively reported, primary-source pain against `anthropics/claude-code`, including issues asking for refunds over wasted token spend: **#71423, #67956, #80581, #72080, #80399, #41461, #40751, #28482, #39755**. (Referenced here as documentation of the failure modes this tool targets — we have not and will not comment on those threads; if you filed one of them, hi.)

Anthropic ships partial native mitigations already (`CLAUDE_CODE_RETRY_WATCHDOG`, `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`), and per #39755 at least one of them has been reported as not functioning as intended in some versions. `claude-watch` is a belt-and-suspenders layer on top, not a replacement — remove it in one line the day the native fix lands for good.

## Install

No install step required — run it directly via `npx`:

```bash
npx github:manhphanxiii/claude-watch run --idle-timeout 5m --max-duration 1h \
  --webhook https://your-endpoint.example.com/hook \
  -- claude -p "do the thing"
```

Or clone + link for a bare `claude-watch` command:

```bash
git clone https://github.com/manhphanxiii/claude-watch.git
cd claude-watch
npm install && npm run build && npm link
```

## GitHub Action

If your headless run already lives in a GitHub Actions workflow, use the bundled
action instead of hand-rolling the `npx` invocation — it's a thin wrapper around
the same CLI, same flags, same exit codes:

```yaml
name: nightly-agent-run
on:
  schedule:
    - cron: '0 3 * * *'

jobs:
  run-claude:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: manhphanxiii/claude-watch@v0.1.1
        id: claude-watch
        with:
          command: claude -p "review the open PRs and merge anything that's green" --output-format stream-json
          idle-timeout: 5m
          max-duration: 1h
          transcript-format: stream-json
          webhook: ${{ secrets.CLAUDE_WATCH_WEBHOOK }}
          slack-webhook: ${{ secrets.CLAUDE_WATCH_SLACK_WEBHOOK }}

      - name: Report result
        if: always()
        run: |
          echo "exit code: ${{ steps.claude-watch.outputs.exit-code }}"
          echo "reason:    ${{ steps.claude-watch.outputs.reason }}"
```

Inputs map 1:1 to the `run` subcommand's flags (`idle-timeout`, `max-duration`,
`grace-period`, `webhook`, `slack-webhook`, `transcript-format`, `detectors`,
`no-detectors`, `quiet`) — see `action.yml` for the full list and defaults. The
step fails with claude-watch's own exit code on any trip (idle-timeout,
max-duration, permission-denial, false-completion, or the wrapped command's own
non-zero code passed through), so no extra `if: failure()` plumbing is needed
to make a bad run show up red. Outputs (`exit-code`, `ok`, `reason`, `detail`)
are also available for workflows that want to branch on the result instead of
just failing the job.

Two things worth knowing before you use it:

- The action builds claude-watch from source on every run (`npm ci`, which
  triggers the same `tsc` build the CLI itself uses) rather than shipping a
  prebuilt `dist/` in the tag — `dist/` is gitignored in this repo, matching
  the source-of-truth-is-source convention used everywhere else here. Expect
  a few seconds of build overhead per run, not a cold `npm install` of a large
  dependency tree (the only runtime dependency is `cross-spawn`).
- It calls `actions/setup-node` internally, which changes the active Node
  version for the rest of the *job*, not just this step. If your job has its
  own steps that need a specific Node version, either run them before this
  action or pin the action's `node-version` input to match.

## Usage

```
claude-watch run [options] -- <command...>
claude-watch dry-run <transcript-file> [options]
```

### `run` — supervise a real invocation

Everything after `--` is the command to run, unmodified — typically `claude -p "..."`, but any command works.

```bash
claude-watch run \
  --idle-timeout 5m \
  --max-duration 1h \
  --webhook https://example.com/hook \
  --slack-webhook https://hooks.slack.com/services/T000/B000/XXXX \
  -- claude -p "review the open PRs and merge anything that's green"
```

| Flag | Default | Meaning |
|---|---|---|
| `--idle-timeout <dur>` | off | Kill the command if its stdout goes silent for this long. Resets on any stdout activity. |
| `--max-duration <dur>` | off | Hard wall-clock ceiling for the whole run, regardless of activity. |
| `--grace-period <dur>` | `10s` | Wait this long after `SIGTERM` before escalating to `SIGKILL`. |
| `--webhook <url>` | — | POST a JSON payload here on any detected failure. |
| `--slack-webhook <url>` | — | POST a Slack-formatted message here (Slack incoming webhook) on any detected failure. |
| `--transcript-format <fmt>` | `text` | `text` (default: detectors are a documented no-op, timeout enforcement still fully applies) or `stream-json` (pass Claude Code's own `--output-format stream-json` through and enable the silent-failure detectors). |
| `--detectors <list>` | all | Comma-separated detector ids to run (`permission-denial`, `false-completion`). |
| `--no-detectors` | — | Disable silent-failure detection entirely; timeout enforcement is unaffected. |
| `--quiet` | off | Don't echo the wrapped command's stdout/stderr to our own. |
| `--json` | off | Print a one-line JSON result summary at the end (for scripting). |

Durations accept a plain millisecond integer or a suffix: `ms`, `s`, `m`, `h` (`30s`, `5m`, `1h`).

### `dry-run` — test detectors without spawning anything

Point it at a canned transcript (a JSON array of transcript entries, or NDJSON) to see what a detector would have done, with no process spawned:

```bash
claude-watch dry-run fixtures/permission-denial-trip.json
claude-watch dry-run my-transcript.jsonl --detectors false-completion --json
```

Useful for tuning detector patterns against a real transcript you've saved from a run that misbehaved, before trusting it in production.

## Exit codes

`claude-watch` composes with `&&` / `||` in cron and CI without you having to parse its output:

| Code | Meaning |
|---|---|
| `0` | Clean completion. |
| `1` | Idle timeout tripped (no stdout activity). |
| `2` | Max-duration (wall-clock) timeout tripped. |
| `3` | `permission-denial` detector tripped. |
| `4` | `false-completion` detector tripped. |
| *(child's own code)* | The wrapped command exited non-zero on its own — that code is passed through unchanged. |

Distinct codes per failure type are a nice-to-have, not a hard guarantee across every flag combination — any non-zero code means "something claude-watch needs you to know about," which is the contract that matters for composing with CI/cron.

## The two silent-failure detectors

Both ship as separate, versioned, overridable rule modules under `src/detectors/` — not hardcoded inline logic — because Claude Code's transcript format is not a stable public schema and detector accuracy against a moving target is the single biggest technical risk in a tool like this. Expect these to need updates as the format evolves; that's why they're versioned (`detector.version`) and why patterns can be overridden without touching the detection logic itself.

They only run in `--transcript-format stream-json` mode, i.e. when you pass `claude`'s own `--output-format stream-json` through and let `claude-watch` parse the resulting JSONL. In plain `text` mode, detectors are a documented no-op and only the idle/wall-clock timeout applies.

- **`permission-denial`** (v1) — trips when a `tool_result` block matches a denial pattern ("permission denied," "not allowed to," "blocked by permission," etc.) **and** execution continues afterward with further `tool_use` calls, **and** nothing in the rest of the transcript surfaces that as an error or acknowledges it to the user. A denial that stops the run, or that gets explicitly surfaced, is not a silent failure and does not trip.
- **`false-completion`** (v1) — trips when the final assistant-visible text claims completion/success ("done," "successfully fixed," "all set," etc.) **and** the transcript contains zero `tool_use` blocks anywhere. This is deliberately the narrowest, highest-confidence slice of "false completion": it does not attempt to semantically match a specific claim to a specific diff (that needs a real correlation engine — noted below as future work), only that *some* tool evidence exists at all when completion is claimed.

Both take an optional pattern override (`patterns` to replace the defaults entirely, or `extraPatterns` to add to them) — see `src/detectors/types.ts`.

## What this is not (v1 scope, on purpose)

Per the CEO decision behind this build: **no dashboard, no fleet view, no TUI, no multi-agent orchestration.** It watches one invocation and tells you when it breaks. That's the whole v1. Specifically out of scope for now:

- A persistent server, database, or UI of any kind (that's [`Claude-Code-Agent-Monitor`](https://github.com/hoangsonww/Claude-Code-Agent-Monitor)'s game, not ours).
- More than two alert channels (generic webhook + Slack). More providers only if users ask.
- Semantic correlation between a specific completion claim and the specific diff that would prove it — v1's `false-completion` detector checks for *any* tool evidence, not evidence matched to the specific claim.
- Structured-output/JSON-schema validation of the wrapped command's own output.
- Retry/backoff logic — `claude-watch` observes and alerts, it does not automatically retry your command for you.

## Related

If what worries you isn't an unattended run hanging but an *interactive*
session quietly running up a bigger bill than you expected, that's a
different tool: [`spendsentry`](https://github.com/manhphanxiii/spendsentry)
reads the same local Claude Code logs and warns you before a live session
crosses a token-spend threshold you set.

## Status

This is a young, thin v1. It is dogfooded in Auto Company's own cron/Routine cycles before any external-facing claim is made about it working — internal use proves the tool functions, it does not by itself prove anyone else needs it. Bug reports and detector-accuracy feedback (false positives *or* false negatives) are the most useful thing you can send.

## License

MIT — see [LICENSE](./LICENSE). Free and open source, no paid tier exists today.
