#!/usr/bin/env node
import * as fs from "fs";
import { parseDuration } from "./duration";
import { runSupervised } from "./runner";
import { postWebhook, postSlackWebhook, AlertPayload } from "./webhook";
import { EXIT_OK } from "./exit-codes";
import { ALL_DETECTORS, runDetectors } from "./detectors";
import { parseTranscript } from "./transcript";

const VERSION = "0.1.0";
const ALL_DETECTOR_IDS = ALL_DETECTORS.map((d) => d.id);

interface RunFlags {
  idleTimeout?: string;
  maxDuration?: string;
  gracePeriod: string;
  webhook?: string;
  slackWebhook?: string;
  transcriptFormat: "text" | "stream-json";
  detectors: string[];
  json: boolean;
  quiet: boolean;
}

function usage(): string {
  return `claude-watch v${VERSION} - reliability supervisor for headless Claude Code / Agent SDK runs

USAGE
  claude-watch run [options] -- <command...>
  claude-watch dry-run <transcript-file> [options]
  claude-watch help

RUN OPTIONS
  --idle-timeout <dur>       Kill if no stdout activity for this long (e.g. 5m, 30s). Off by default.
  --max-duration <dur>       Hard wall-clock ceiling for the whole run (e.g. 1h). Off by default.
  --grace-period <dur>       Wait this long after SIGTERM before SIGKILL. Default: 10s.
  --webhook <url>            POST a JSON payload here on any detected failure.
  --slack-webhook <url>      POST a Slack-formatted message here on any detected failure.
  --transcript-format <fmt>  "text" (default, detectors disabled) or "stream-json"
                             (pass claude's own --output-format stream-json through).
  --detectors <list>         Comma-separated detector ids to run. Default: all (${ALL_DETECTOR_IDS.join(",")}).
  --no-detectors             Disable silent-failure detection; timeout enforcement still applies.
  --quiet                    Don't echo the wrapped command's stdout to our own stdout.
  --json                     Print a one-line JSON result summary to stdout at the end.

DRY-RUN OPTIONS (test detectors against a canned transcript, no process spawned)
  --detectors <list>         Comma-separated detector ids to run. Default: all.
  --json                     Print machine-readable results.

Durations accept a plain millisecond integer or a suffix: ms, s, m, h.
Exit codes: 0 clean, 1 idle-timeout, 2 max-duration, 3 permission-denial,
4 false-completion, 5 (or the child's own code) on a plain non-zero exit.
`;
}

function splitOnDoubleDash(argv: string[]): { flagArgs: string[]; command: string[] } {
  const idx = argv.indexOf("--");
  if (idx === -1) return { flagArgs: argv, command: [] };
  return { flagArgs: argv.slice(0, idx), command: argv.slice(idx + 1) };
}

function parseRunFlags(flagArgs: string[]): RunFlags {
  const flags: RunFlags = {
    gracePeriod: "10s",
    transcriptFormat: "text",
    detectors: ALL_DETECTOR_IDS,
    json: false,
    quiet: false,
  };

  const takeValue = (name: string, i: { v: number }): string => {
    const value = flagArgs[++i.v];
    if (value === undefined) {
      console.error(`Error: ${name} requires a value.`);
      process.exit(2);
    }
    return value;
  };

  const i = { v: 0 };
  for (; i.v < flagArgs.length; i.v++) {
    const arg = flagArgs[i.v];
    switch (arg) {
      case "--idle-timeout":
        flags.idleTimeout = takeValue(arg, i);
        break;
      case "--max-duration":
        flags.maxDuration = takeValue(arg, i);
        break;
      case "--grace-period":
        flags.gracePeriod = takeValue(arg, i);
        break;
      case "--webhook":
        flags.webhook = takeValue(arg, i);
        break;
      case "--slack-webhook":
        flags.slackWebhook = takeValue(arg, i);
        break;
      case "--transcript-format": {
        const value = takeValue(arg, i);
        if (value !== "text" && value !== "stream-json") {
          console.error(`Error: --transcript-format must be "text" or "stream-json", got "${value}".`);
          process.exit(2);
        }
        flags.transcriptFormat = value;
        break;
      }
      case "--detectors":
        flags.detectors = takeValue(arg, i).split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--no-detectors":
        flags.detectors = [];
        break;
      case "--json":
        flags.json = true;
        break;
      case "--quiet":
        flags.quiet = true;
        break;
      default:
        console.error(`Unknown flag: ${arg}`);
        process.exit(2);
    }
  }
  return flags;
}

async function sendAlerts(flags: { webhook?: string; slackWebhook?: string }, payload: AlertPayload) {
  const jobs: Promise<void>[] = [];
  if (flags.webhook) jobs.push(postWebhook(flags.webhook, payload));
  if (flags.slackWebhook) jobs.push(postSlackWebhook(flags.slackWebhook, payload));
  await Promise.all(jobs);
}

async function runCommand(argv: string[]): Promise<number> {
  const { flagArgs, command } = splitOnDoubleDash(argv);
  if (command.length === 0) {
    console.error('Error: no command given. Usage: claude-watch run [options] -- <command...>');
    return 2;
  }
  const flags = parseRunFlags(flagArgs);

  let idleTimeoutMs: number | undefined;
  let maxDurationMs: number | undefined;
  let gracePeriodMs: number;
  try {
    idleTimeoutMs = flags.idleTimeout ? parseDuration(flags.idleTimeout) : undefined;
    maxDurationMs = flags.maxDuration ? parseDuration(flags.maxDuration) : undefined;
    gracePeriodMs = parseDuration(flags.gracePeriod);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const result = await runSupervised({
    command,
    idleTimeoutMs,
    maxDurationMs,
    gracePeriodMs,
    transcriptFormat: flags.transcriptFormat,
    detectorIds: flags.detectors,
    onStdout: flags.quiet ? undefined : (chunk) => process.stdout.write(chunk),
    onStderr: flags.quiet ? undefined : (chunk) => process.stderr.write(chunk),
  });

  if (result.reason) {
    const payload: AlertPayload = {
      tool: "claude-watch",
      version: VERSION,
      status: "failed",
      reason: result.reason,
      detail: result.detail ?? "",
      command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timestamp: new Date().toISOString(),
    };
    await sendAlerts(flags, payload);
    console.error(`\nclaude-watch: FAILURE [${result.reason}] ${result.detail ?? ""}`);
  }

  if (flags.json) {
    console.log(
      JSON.stringify({
        ok: result.exitCode === EXIT_OK,
        exitCode: result.exitCode,
        reason: result.reason ?? null,
        detail: result.detail ?? null,
        durationMs: result.durationMs,
      })
    );
  }

  return result.exitCode;
}

async function dryRunCommand(argv: string[]): Promise<number> {
  const file = argv[0];
  if (!file || file.startsWith("--")) {
    console.error("Error: usage: claude-watch dry-run <transcript-file> [--detectors a,b] [--json]");
    return 2;
  }

  let detectorIds = ALL_DETECTOR_IDS;
  let json = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--detectors") {
      detectorIds = argv[++i]?.split(",").map((s) => s.trim()).filter(Boolean) ?? detectorIds;
    } else if (argv[i] === "--json") {
      json = true;
    }
  }

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    console.error(`Error: could not read "${file}": ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  // Accept either a JSON array of transcript entries, or NDJSON (one entry per line) —
  // whichever is more convenient for hand-written fixtures.
  let entries;
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    entries = JSON.parse(trimmed);
  } else {
    entries = parseTranscript(raw);
  }

  const outcomes = runDetectors(entries, detectorIds);
  const anyTripped = outcomes.some((o) => o.result.tripped);

  if (json) {
    console.log(
      JSON.stringify(
        outcomes.map((o) => ({ detector: o.detector.id, version: o.detector.version, ...o.result })),
        null,
        2
      )
    );
  } else {
    for (const { detector, result } of outcomes) {
      const status = result.tripped ? "TRIPPED" : "clean";
      console.log(`[${detector.id} v${detector.version}] ${status}: ${result.detail}`);
    }
    console.log(anyTripped ? "\nResult: FAILURE (at least one detector tripped)" : "\nResult: clean pass");
  }

  return anyTripped ? 1 : 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  switch (command) {
    case "run":
      process.exitCode = await runCommand(argv.slice(1));
      break;
    case "dry-run":
      process.exitCode = await dryRunCommand(argv.slice(1));
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(usage());
      process.exitCode = command === undefined ? 2 : 0;
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(usage());
      process.exitCode = 2;
  }
}

main();
