import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import { postWebhook, postSlackWebhook, AlertPayload } from "../webhook";

function withServer(handler: (req: http.IncomingMessage, body: string) => void): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        handler(req, body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const samplePayload: AlertPayload = {
  tool: "claude-watch",
  version: "0.1.0",
  status: "failed",
  reason: "idle-timeout",
  detail: "No stdout activity for 30s",
  command: ["claude", "-p", "do the thing"],
  exitCode: 1,
  durationMs: 45000,
  timestamp: new Date().toISOString(),
};

test("postWebhook POSTs the JSON payload with the correct fields", async () => {
  let received: any;
  const server = await withServer((req, body) => {
    received = { method: req.method, contentType: req.headers["content-type"], json: JSON.parse(body) };
  });
  try {
    await postWebhook(server.url, samplePayload);
    assert.equal(received.method, "POST");
    assert.match(received.contentType, /application\/json/);
    assert.equal(received.json.reason, "idle-timeout");
    assert.equal(received.json.tool, "claude-watch");
    assert.deepEqual(received.json.command, ["claude", "-p", "do the thing"]);
  } finally {
    await server.close();
  }
});

test("postSlackWebhook POSTs a Slack-formatted text payload", async () => {
  let received: any;
  const server = await withServer((_req, body) => {
    received = JSON.parse(body);
  });
  try {
    await postSlackWebhook(server.url, samplePayload);
    assert.equal(typeof received.text, "string");
    assert.match(received.text, /claude-watch/);
    assert.match(received.text, /idle-timeout/);
  } finally {
    await server.close();
  }
});

test("postWebhook does not throw when the endpoint is unreachable", async () => {
  await assert.doesNotReject(postWebhook("http://127.0.0.1:1/nope", samplePayload));
});

// Regression test for a shipped bug: postJson() called bare fetch() with no
// timeout. An endpoint that accepts the TCP connection but never sends a
// response (unlike ECONNREFUSED above, which fails fast) would hang the
// await indefinitely — and with it cli.ts's `sendAlerts()`, and the whole
// claude-watch process, past its own configured idle/max-duration settings.
test("postWebhook resolves within a bounded time against a hanging (non-responding) endpoint", async () => {
  const server = http.createServer((_req, _res) => {
    // Deliberately never call res.end() / res.writeHead() — simulates a
    // server that accepted the connection but never responds.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  try {
    const startedAt = Date.now();
    // Use a short override timeout so the test doesn't have to wait out the
    // real 5s production default to prove the timeout mechanism works.
    await assert.doesNotReject(postWebhook(url, samplePayload, 300));
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 2000, `expected the timeout to bound the call, took ${elapsedMs}ms`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
