import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration, formatDuration } from "../duration";

test("parseDuration: plain integer is milliseconds", () => {
  assert.equal(parseDuration("1500"), 1500);
});

test("parseDuration: suffixed values", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("5m"), 5 * 60_000);
  assert.equal(parseDuration("1h"), 60 * 60_000);
  assert.equal(parseDuration("250ms"), 250);
  assert.equal(parseDuration("1.5s"), 1500);
});

test("parseDuration: rejects garbage", () => {
  assert.throws(() => parseDuration("banana"));
  assert.throws(() => parseDuration("10x"));
});

test("formatDuration: round-trips readable output", () => {
  assert.equal(formatDuration(500), "500ms");
  assert.equal(formatDuration(1500), "1.5s");
  assert.equal(formatDuration(90_000), "1.5m");
});
