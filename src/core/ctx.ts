/**
 * The contract between the entry point and every command: the injected I/O and the per-invocation
 * context. Lives in core/ rather than cli.ts so commands depend on a stable type, not on the
 * dispatcher that imports them all (#124).
 */

import type { ParsedArgs } from "./args.ts";
import type { CallerDetection } from "./caller.ts";
import type { DataWriter } from "./policy.ts";
import type { PrivacyPolicy } from "./privacy.ts";
import type { OutputFormat } from "./output.ts";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  stdoutIsTty: boolean;
  stdinIsTty: boolean;
  env: NodeJS.ProcessEnv;
  readStdin: () => Promise<string>;
  /**
   * Ask the person at the terminal something. `hidden` suppresses echo, for a credential.
   *
   * Absent when there is nothing to ask — no TTY, or a test that has not opted in — so every caller
   * must handle its absence rather than assume an interactive human is there (STORY-09: never hang
   * waiting for input that cannot arrive).
   */
  prompt?: ((question: string, opts?: { hidden?: boolean }) => Promise<string>) | undefined;
}

export interface Ctx {
  args: ParsedArgs;
  io: Io;
  format: OutputFormat;
  color: boolean;
  caller: CallerDetection;
  /**
   * Open stdout for server DATA (rows, entities, field values) — AC-51.1. Applies the ADR 0007
   * gate and throws `PolicyError` under a detected agent without an explicit acknowledgement;
   * m1 has no pseudonymization engine, so stopping is the honest behaviour.
   *
   * This is the data-output boundary, not a convention (Brooks review M3): `renderResultTable`
   * and `renderDataDocument` accept only the `DataWriter` it returns, so a new command cannot
   * emit rows by forgetting a call — it would have to reach for `unsafeDataWriter` and say why.
   * Calling it is side-effect-free, so call it early too, before the network round trip, so a
   * refusal costs no request. `--explain` emits no data and is exempt.
   */
  openData: (what: string) => DataWriter;
  /**
   * The effective pseudonymization policy (REQ-057). Resolved once, from the profile and the caller
   * context — never from something the caller passed, except that a caller may tighten it
   * (ADR 0009 Decision 1).
   */
  privacy: PrivacyPolicy;
}
