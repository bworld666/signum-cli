/**
 * The re-identification handle store (REQ-058): the one file where `ref_` handles and the real
 * identities they stand for sit side by side, and persisting newly minted handles into it.
 */

import type { Ctx } from "./ctx.ts";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { configDir, writePrivate } from "./config.ts";
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

/**
 * `ref:…` handle -> the real `TypeName;id` it stands for.
 *
 * Stored `0600` and per-profile, matching the surrogate secret's scope (AC-53.3, AC-53.8): a handle
 * is only meaningful against the secret that produced it, so the two must live and die together.
 *
 * **This file is the one place real identities and their surrogates sit side by side.** It is never
 * emitted — not to stdout, not to `--json`, not to a trace (AC-53.3). `unmask` reads it and
 * prints one answer at a time, for a human.
 */
export function handlesPath(env?: NodeJS.ProcessEnv): string {
  return join(configDir(env), "handles.json");
}

/**
 * What a handle stands for (#106).
 *
 * `lite` is the identity — the only field the store originally held, and the only one it needs to be
 * correct. `label` is the display string, kept so `unmask` can produce a document a human can
 * actually read instead of one full of `Project;20`. It is OPTIONAL for two reasons that both matter:
 * a handle minted before this existed has none, and a projection that returned no label cannot invent
 * one.
 */
export interface HandleEntry {
  lite: string;
  label?: string;
  /** When the label was captured, so a stale one is at least dateable. ISO 8601. */
  seen?: string;
}

/**
 * Read the handle store, accepting BOTH shapes.
 *
 * The original format mapped handle -> `"Type;id"` as a bare string. Existing stores hold thousands
 * of those, so the string form is read as an entry with no label rather than discarded — dropping
 * them would orphan every handle in circulation, which is the failure AC-53.5 exists to prevent.
 */
export function loadHandleEntries(env?: NodeJS.ProcessEnv): Record<string, HandleEntry> {
  const path = handlesPath(env);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, HandleEntry> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") {
        out[k] = { lite: v };
        continue;
      }
      if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
      const rec = v as Record<string, unknown>;
      const lite = rec["lite"];
      if (typeof lite !== "string" || lite === "") continue;
      const label = rec["label"];
      const seen = rec["seen"];
      out[k] = {
        lite,
        ...(typeof label === "string" && label !== "" ? { label } : {}),
        ...(typeof seen === "string" && seen !== "" ? { seen } : {}),
      };
    }
    return out;
  } catch {
    // A corrupt store must not stop the CLI working; it means handles stop resolving, which
    // `unmask` reports honestly rather than guessing (AC-53.5).
    return {};
  }
}

/**
 * The identity-only view, which is what every resolution path needs.
 *
 * Kept as the primary accessor because a caller resolving a handle to act on a record must get the
 * `Lite` key and nothing else — a label is for reading, never for addressing.
 */
export function loadHandles(env?: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(loadHandleEntries(env))) out[k] = v.lite;
  return out;
}

/**
 * Merge new handles in and persist, atomically at `0600`.
 *
 * @returns the handles that COLLIDED — same handle, different real value. Never silently
 * overwritten: a collision means two identities would share one surrogate, and AC-53.6's rule that a
 * mismatch is an explicit error rather than a silent one applies at least as strongly here.
 */
export function saveHandles(
  fresh: Readonly<Record<string, string | HandleEntry>>,
  env?: NodeJS.ProcessEnv,
  options: { storeLabels?: boolean; now?: string } = {},
): string[] {
  const existing = loadHandleEntries(env);
  const collisions: string[] = [];
  const storeLabels = options.storeLabels ?? true;

  // The opt-out is about what is AT REST, so it applies to the whole file, not only to what is being
  // written now. Applying it per-incoming-handle meant a user who set `storeLabels: false` kept every
  // name captured before that moment, indefinitely, while reasonably believing the store was
  // identity-only — the setting appeared to work because the handles they then touched lost theirs.
  if (!storeLabels) {
    for (const [handle, entry] of Object.entries(existing)) {
      if (entry.label !== undefined) existing[handle] = { lite: entry.lite };
    }
  }

  for (const [handle, incoming] of Object.entries(fresh)) {
    const entry: HandleEntry = typeof incoming === "string" ? { lite: incoming } : incoming;
    const prior = existing[handle];

    // The collision rule is about IDENTITY only. A differing label is not a collision — the display
    // string can legitimately change when someone is renamed — so it updates in place, while a
    // differing `lite` still refuses.
    if (prior !== undefined && prior.lite !== entry.lite) {
      collisions.push(handle);
      continue;
    }

    const label = storeLabels ? (entry.label ?? prior?.label) : undefined;
    existing[handle] = {
      lite: entry.lite,
      ...(label !== undefined ? { label } : {}),
      // Stamped only when a label is actually held, since it dates the label and nothing else.
      ...(label !== undefined
        ? { seen: entry.label !== undefined ? (options.now ?? new Date().toISOString()) : prior?.seen ?? options.now ?? new Date().toISOString() }
        : {}),
    };
  }
  writePrivate(handlesPath(env), JSON.stringify(existing, null, 2) + "\n");
  return collisions;
}

/** Forget every stored label, keeping the identities. The `storeLabels: false` retro-fit. */
export function stripStoredLabels(env?: NodeJS.ProcessEnv): number {
  const existing = loadHandleEntries(env);
  let removed = 0;
  const out: Record<string, HandleEntry> = {};
  for (const [handle, entry] of Object.entries(existing)) {
    if (entry.label !== undefined) removed++;
    out[handle] = { lite: entry.lite };
  }
  if (removed > 0) writePrivate(handlesPath(env), JSON.stringify(out, null, 2) + "\n");
  return removed;
}

export function clearHandles(env?: NodeJS.ProcessEnv): boolean {
  const path = handlesPath(env);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
