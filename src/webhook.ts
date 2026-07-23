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

/** Uses Node 18+ global `fetch` — no HTTP client dependency needed. */
export async function postWebhook(url: string, payload: AlertPayload): Promise<void> {
  await postJson(url, payload);
}

export async function postSlackWebhook(url: string, payload: AlertPayload): Promise<void> {
  const text =
    `:rotating_light: *claude-watch* detected a failure\n` +
    `*Reason:* ${payload.reason}\n` +
    `*Command:* \`${payload.command.join(" ")}\`\n` +
    `*Exit code:* ${payload.exitCode}\n` +
    `*Duration:* ${(payload.durationMs / 1000).toFixed(1)}s\n` +
    `*Detail:* ${payload.detail}`;
  await postJson(url, { text });
}

async function postJson(url: string, body: unknown): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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
