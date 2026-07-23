/**
 * Exit code contract. 0 is the only "safe" code — every other path is
 * "something claude-watch needs you to know about," so it composes with
 * `&&` / `||` in CI and cron without requiring the caller to parse output.
 *
 * Distinct codes per failure type are a nice-to-have (per CTO diligence),
 * not a hard guarantee across every combination of flags — see README.
 */
export const EXIT_OK = 0;
export const EXIT_IDLE_TIMEOUT = 1;
export const EXIT_MAX_DURATION = 2;
export const EXIT_PERMISSION_DENIAL = 3;
export const EXIT_FALSE_COMPLETION = 4;
// Child exited non-zero on its own (already visible, but still surfaced so
// `claude-watch run -- claude -p ...` fails the same way `claude -p ...` would).
export const EXIT_CHILD_FAILED = 5;

export type FailureReason =
  | "idle-timeout"
  | "max-duration"
  | "permission-denial"
  | "false-completion"
  | "child-exit-nonzero";

export function exitCodeForReason(reason: FailureReason): number {
  switch (reason) {
    case "idle-timeout":
      return EXIT_IDLE_TIMEOUT;
    case "max-duration":
      return EXIT_MAX_DURATION;
    case "permission-denial":
      return EXIT_PERMISSION_DENIAL;
    case "false-completion":
      return EXIT_FALSE_COMPLETION;
    case "child-exit-nonzero":
      return EXIT_CHILD_FAILED;
  }
}
