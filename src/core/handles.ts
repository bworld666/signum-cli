/**
 * Persisting `ref_` handles minted while emitting pseudonymized output (REQ-058).
 */

import type { Ctx } from "./ctx.ts";
import { saveHandles } from "./config.ts";
import { CliError, ExitCode } from "./errors.ts";

/**
 * Store freshly minted `ref:` handles (REQ-058), and refuse to continue if any collided.
 *
 * A collision means two real identities would share one handle. Reporting it is not pedantry: the
 * whole point of a handle is that resolving it yields the record the agent actually acted on, and a
 * silent mismatch there is worse than no handle at all (AC-53.6).
 */
export function persistHandles(
  ctx: Ctx,
  entries: Readonly<Record<string, string | { lite: string; label?: string }>>,
): void {
  if (Object.keys(entries).length === 0) return;
  // `storeLabels` is a deliberate opt-OUT (#106): storing labels turns this file from a store of
  // identities into a store of names, which is a real change in what is at rest on disk. Default on,
  // because a store of `Project;20` does not deliver the readable report the handles exist for.
  const collisions = saveHandles(entries, ctx.io.env, { storeLabels: ctx.privacy.storeLabels });
  if (collisions.length > 0) {
    throw new CliError(
      `handle collision: ${collisions.join(", ")} already stands for a different record`,
      ExitCode.Unexpected,
      {
        hint:
          "This should be effectively impossible at 48 bits, so treat it as a bug worth reporting.\n" +
          "Nothing was emitted, and the existing mapping was left untouched.",
      },
    );
  }
}
