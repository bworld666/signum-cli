/**
 * The signum config directory and the private-file writer every store in it uses.
 *
 * Stores: credentials.ts (REQ-006), metadata-cache.ts (REQ-010), handles.ts (REQ-058), instances.ts (REQ-001).
 */

import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["SIGNUM_CONFIG_DIR"];
  if (explicit !== undefined && explicit !== "") return explicit;
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg !== "") return join(xdg, "signum");
  return join(homedir(), ".config", "signum");
}

export function writePrivate(path: string, contents: string): void {
  // mode/chmod below are POSIX-only. On Windows they toggle nothing but the read-only attribute
  // (see checkPermissions), and the file's real protection is the profile directory's inherited
  // ACL — which Node cannot set. Kept unconditional because they are correct where they work and
  // harmless where they do not.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Write-then-rename so a concurrent reader never sees a half-written token (AC-04.4).
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/**
 * Write a secret with the same protections as a credential: 0600 where the platform supports it,
 * atomic rename so a concurrent reader never sees a half-written value. Used for the
 * pseudonymization secret, whose loss would silently change every surrogate (REQ-057).
 */
export function writeSecret(path: string, contents: string): void {
  writePrivate(path, contents + "\n");
}

