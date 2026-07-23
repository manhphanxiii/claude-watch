import { Detector, DetectorConfig, DetectorResult } from "./types";
import { permissionDenialDetector } from "./permission-denial";
import { falseCompletionDetector } from "./false-completion";
import { TranscriptEntry } from "../transcript";

export const ALL_DETECTORS: Detector[] = [permissionDenialDetector, falseCompletionDetector];

export function detectorById(id: string): Detector | undefined {
  return ALL_DETECTORS.find((d) => d.id === id);
}

export interface DetectorRunOutcome {
  detector: Detector;
  result: DetectorResult;
}

/**
 * Run a set of detectors (by id, default: all) against parsed transcript
 * entries. Returns every outcome (tripped or not) so callers can report
 * both the failure and the "why not" reasoning for a clean pass.
 */
export function runDetectors(
  entries: TranscriptEntry[],
  detectorIds: string[] = ALL_DETECTORS.map((d) => d.id),
  configs: Record<string, DetectorConfig> = {}
): DetectorRunOutcome[] {
  return detectorIds
    .map((id) => detectorById(id))
    .filter((d): d is Detector => Boolean(d))
    .map((detector) => ({ detector, result: detector.run(entries, configs[detector.id]) }));
}

export { Detector, DetectorConfig, DetectorResult };
