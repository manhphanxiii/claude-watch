import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { permissionDenialDetector } from "../detectors/permission-denial";
import { falseCompletionDetector } from "../detectors/false-completion";

const FIXTURES = path.join(__dirname, "..", "..", "fixtures");

function loadFixture(name: string) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

test("permission-denial detector trips on denial + silent continuation", () => {
  const entries = loadFixture("permission-denial-trip.json");
  const result = permissionDenialDetector.run(entries);
  assert.equal(result.tripped, true);
});

test("permission-denial detector stays clean when the denial is surfaced", () => {
  const entries = loadFixture("permission-denial-clean.json");
  const result = permissionDenialDetector.run(entries);
  assert.equal(result.tripped, false);
});

test("false-completion detector trips on a claim with zero tool_use evidence", () => {
  const entries = loadFixture("false-completion-trip.json");
  const result = falseCompletionDetector.run(entries);
  assert.equal(result.tripped, true);
});

test("false-completion detector stays clean when tool_use evidence exists", () => {
  const entries = loadFixture("false-completion-clean.json");
  const result = falseCompletionDetector.run(entries);
  assert.equal(result.tripped, false);
});

test("false-completion detector is a no-op on empty transcript", () => {
  const result = falseCompletionDetector.run([]);
  assert.equal(result.tripped, false);
});

test("permission-denial detector respects custom pattern override", () => {
  const entries = loadFixture("permission-denial-trip.json");
  // Overriding with a pattern that will never match should force a clean pass.
  const result = permissionDenialDetector.run(entries, { patterns: ["this-will-never-match-anything"] });
  assert.equal(result.tripped, false);
});
