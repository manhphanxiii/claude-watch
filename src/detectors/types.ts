import { TranscriptEntry } from "../transcript";

export interface DetectorResult {
  tripped: boolean;
  /** Short machine-readable reason, e.g. "permission-denial-without-error". */
  reason: string;
  /** Human-readable explanation, safe to put directly in an alert payload. */
  detail: string;
}

export interface DetectorConfig {
  /** Additional regex patterns merged with the built-in defaults. */
  extraPatterns?: string[];
  /** Replace the built-in defaults entirely instead of merging. */
  patterns?: string[];
}

export interface Detector {
  /** Stable id used in `--detectors` allow/deny lists and alert payloads. */
  id: string;
  /** Bump when detection logic changes in a way that could flip a verdict. */
  version: number;
  description: string;
  run(entries: TranscriptEntry[], config?: DetectorConfig): DetectorResult;
}
