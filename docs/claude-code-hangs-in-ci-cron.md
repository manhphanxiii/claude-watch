# Claude Code Hangs in CI or Cron? Here's Why, and How to Catch It Automatically

You scheduled Claude Code to run unattended — a cron job, a GitHub Actions step, a nightly Routine — and it either ran forever, or finished and lied about what it did. Nobody was watching the terminal, so nothing told you. This page is a plain answer to that problem, and a free, MIT-licensed tool ([`claude-watch`](https://github.com/manhphanxiii/claude-watch)) that fixes it in one wrapped command. No sign-up, no dashboard, no vendor lock-in — read the source if you don't trust the claim.

## The three ways an unattended Claude Code run fails silently

If you found this page, you're probably searching one of these. Pick yours:

### 1. "Claude Code hangs in CI" / "claude -p never returns" / "stuck with no output"

The process just... sits there. No new stdout, no error, no exit. In an interactive terminal you'd notice and hit Ctrl-C. In a cron job or a CI runner, it either times out the whole pipeline after an expensive wall-clock ceiling (wasting the runner-minutes budget), or — worse, if the surrounding job has no timeout of its own — it hangs until something else kills it.

**Why it happens:** agentic loops don't have a hard-coded "give up" instinct. A tool call can wait on a permission prompt in a headless context that will never resolve, a subagent can spin without making forward progress, or the model can get stuck retrying something that will never succeed. Anthropic ships partial native mitigations (`CLAUDE_CODE_RETRY_WATCHDOG`, `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`), but as of this writing at least one has been reported as not functioning as intended in some versions ([anthropics/claude-code#39755](https://github.com/anthropics/claude-code/issues/39755)) — which is exactly the gap an external, independent timeout layer exists to cover.

**The fix:** wrap the invocation with an idle timeout (kills it if stdout goes silent for N seconds/minutes) *and* a wall-clock ceiling (kills it after N total, no matter what):

```bash
npx github:manhphanxiii/claude-watch run --idle-timeout 5m --max-duration 1h -- claude -p "do the thing"
```

Exit code `1` means the idle timer tripped; `2` means the wall-clock ceiling did. Either way, your cron/CI step gets a non-zero exit instead of hanging — which is the one thing that lets `&&`, `||`, and CI failure handling actually work.

### 2. "Claude code cron reliability" / "how to run claude code unattended safely" / "claude code headless best practices"

If you're scoping out how to run Claude Code unattended at all — before you've hit a specific incident — the short version: treat it like any other unattended process that can misbehave. Three things you want regardless of which tool enforces them:

1. **A hard timeout, both idle and wall-clock.** Don't rely on the job scheduler's own timeout alone — a scheduler timeout tells you "it ran too long," not "here's what state it was in when it died," and it doesn't distinguish "still making progress slowly" from "completely stuck."
2. **A way to tell "exited 0" from "actually did what it was supposed to."** See silent failures below — a clean exit code is necessary but not sufficient evidence of success in an agentic run.
3. **An alert that reaches you outside the CI log.** If the only record of a failure is a CI run nobody opens, it isn't monitoring — it's an archive.

`claude-watch` is one way to get all three without standing up infrastructure: it's a single wrapper process, no server, no database, that exits non-zero on trouble and can fire a webhook or Slack alert at the same moment.

### 3. "Detect silent failure claude agent" / "claude code false completion" / "claude code says done but did nothing" / "claude code ignored permission denial"

This is the failure mode that a timeout alone does *not* catch: the run finishes, exits `0`, and *looks* successful — but it didn't actually do the work. Two documented, primary-source patterns:

- **Silent permission denial.** A tool call gets denied (no filesystem access, no network, whatever the sandbox disallows), and instead of stopping or surfacing that as an error, the agent just continues as if nothing happened — and reports success at the end. See [anthropics/claude-code#71423](https://github.com/anthropics/claude-code/issues/71423), [#67956](https://github.com/anthropics/claude-code/issues/67956), [#72080](https://github.com/anthropics/claude-code/issues/72080).
- **False completion claims.** The final message says "done," "successfully fixed," "all set" — and the transcript shows zero tool calls that could have produced that outcome. See [anthropics/claude-code#80581](https://github.com/anthropics/claude-code/issues/80581) ("Misleading Progress Reporting... False Completion Claims") and [#41461](https://github.com/anthropics/claude-code/issues/41461).

These aren't edge cases someone imagined — they're dated, primary-source issues against `anthropics/claude-code` itself, several with users reporting real wasted token spend. (We're citing them here as documentation of the failure pattern this tool targets; we haven't and won't comment on those threads.)

**The fix:** run Claude Code with structured output (`--output-format stream-json`) and let `claude-watch` parse the transcript with two purpose-built detectors:

```bash
npx github:manhphanxiii/claude-watch run \
  --transcript-format stream-json \
  --webhook https://your-endpoint.example.com/hook \
  -- claude -p "do the thing" --output-format stream-json
```

`permission-denial` trips when a denial is followed by continued tool use with no surfaced error. `false-completion` trips when a completion claim has zero supporting tool-use evidence. Both are versioned, overridable rule modules — not a black box — because Claude Code's transcript format isn't a stable public schema, and honest tools admit that detector accuracy will need to evolve with it. See the [main README](../README.md#the-two-silent-failure-detectors) for exact trip conditions and pattern overrides.

## Wiring it into GitHub Actions

```yaml
- name: Run Claude Code unattended, with a reliability wrapper
  run: |
    npx github:manhphanxiii/claude-watch run \
      --idle-timeout 5m --max-duration 30m \
      --transcript-format stream-json \
      --slack-webhook "${{ secrets.SLACK_WEBHOOK_URL }}" \
      -- claude -p "${{ inputs.task }}" --output-format stream-json
```

A non-zero exit here fails the step the normal way — no special handling needed, no polling, no extra service to run.

## Wiring it into cron

```bash
# crontab -e
0 * * * * /usr/local/bin/npx github:manhphanxiii/claude-watch run \
  --idle-timeout 10m --max-duration 2h \
  --webhook https://your-endpoint.example.com/hook \
  -- claude -p "nightly task" >> /var/log/claude-watch.log 2>&1
```

If the job hangs, `claude-watch` kills it and your webhook fires — you find out from a Slack message, not from noticing the log stopped updating three days later.

## FAQ

**Does this replace Anthropic's own timeout env vars?**
No — treat it as a belt-and-suspenders layer on top, not a replacement. If Anthropic's native timeout handling is working correctly for your version, `claude-watch`'s idle/wall-clock timers are redundant-but-harmless; if it isn't (see #39755), you're still covered. Remove `claude-watch` in one line the day you trust the native fix fully.

**Does it require an account, API key of its own, or network access to a third-party service?**
No. It has no backend and no telemetry. It spawns your command, watches stdout and wall-clock time locally, and — only if you configure `--webhook` or `--slack-webhook` — POSTs a JSON or Slack-formatted payload to a URL *you* provide. No data goes anywhere you didn't point it.

**Does it work with Claude Agent SDK invocations, not just the `claude` CLI?**
Yes — it wraps any command; there's nothing `claude`-CLI-specific about the process-supervision layer. The two transcript detectors expect `stream-json`-shaped output, which the CLI's `--output-format stream-json` flag produces; if your Agent SDK invocation emits a comparable JSONL transcript, point `claude-watch` at it the same way.

**What does it NOT do?**
No dashboard, no fleet view of multiple sessions, no multi-agent orchestration, no retry/backoff. It watches one invocation and tells you when it breaks — see [What this is not](../README.md#what-this-is-not-v1-scope-on-purpose) in the main README for the full, deliberately-narrow v1 scope.

## Related reading

- [Main README](../README.md) — install, full flag reference, exit codes, detector internals.
- [anthropics/claude-code issues referenced above](../README.md#why-this-exists) — the primary-source pain this tool targets.
- [`Claude-Code-Agent-Monitor`](https://github.com/hoangsonww/Claude-Code-Agent-Monitor) — if what you actually want is a live dashboard/visualization of running sessions rather than a hang/silent-failure watchdog, that's a different (and larger) tool than this one.

---

*This page is dogfooded documentation, not a landing page written before the tool existed — every command on it is copy-pasteable against the real `v0.1.0` CLI. If a command here doesn't work as written, that's a bug — [open an issue](https://github.com/manhphanxiii/claude-watch/issues).*
