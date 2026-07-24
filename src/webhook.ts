import { FailureReason } from "./exit-codes";

export interface AlertPayload {
  tool: "claude-watch";
  version: string;
  status: "failed";
  reason: FailureReason;
  detail: string;
  command: string[];
  exitCode: number;
  durationMs: number;
  timestamp: string;
}

// Fixed, sane default: this is an alert POST fired after a run has already
// failed, not something worth a CLI config knob. Without a timeout, an
// endpoint that accepts the TCP connection but never responds would hang
// `sendAlerts()` — and with it the whole `claude-watch` process, since
// cli.ts awaits alerts before printing results — indefinitely, past its own
// configured idle/max-duration settings. `timeoutMs` is an optional internal
// override (not exposed as a flag) so tests can exercise the hang path
// without a slow, real 5s wait.
const WEBHOOK_TIMEOUT_MS = 5000;

/** Uses Node 18+ global `fetch` — no HTTP client dependency needed. */
export async function postWebhook(url: string, payload: AlertPayload, timeoutMs = WEBHOOK_TIMEOUT_MS): Promise<void> {
  await postJson(url, payload, timeoutMs);
}

export async function postSlackWebhook(url: string, payload: AlertPayload, timeoutMs = WEBHOOK_TIMEOUT_MS): Promise<void> {
  const text =
    `:rotating_light: *claude-watch* detected a failure\n` +
    `*Reason:* ${payload.reason}\n` +
    `*Command:* \`${payload.command.join(" ")}\`\n` +
    `*Exit code:* ${payload.exitCode}\n` +
    `*Duration:* ${(payload.durationMs / 1000).toFixed(1)}s\n` +
    `*Detail:* ${payload.detail}`;
  await postJson(url, { text }, timeoutMs);
}

async function postJson(url: string, body: unknown, timeoutMs: number = WEBHOOK_TIMEOUT_MS): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      process.stderr.write(`claude-watch: webhook POST to ${url} returned HTTP ${res.status}\n`);
    }
  } catch (err) {
    process.stderr.write(
      `claude-watch: webhook POST to ${url} failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}
