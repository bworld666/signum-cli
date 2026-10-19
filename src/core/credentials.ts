/**
 * The stored credential: save, load, rotate, delete, and the permission check on its file.
 *
 * REQ-006, STORY-04 · AC-04.1 (0600), AC-04.4 (atomic rotation), AC-11.5
 *
 * The handed-over token is the ONLY credential available against the target application
 * (ADR 0004 Decision 4), so losing it costs a manual browser round trip. Rotation writes
 * are therefore atomic and their failure is surfaced, not swallowed (AC-12.12).
 */

import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { configDir, writePrivate } from "./config.ts";

export interface StoredCredential {
  url: string;
  token: string;
  /** How the credential was obtained; informational. */
  source: "browser-handoff";
  savedAt: string;
  rotatedAt?: string;
}

function credentialPath(env?: NodeJS.ProcessEnv): string {
  return join(configDir(env), "credential.json");
}

export function saveCredential(cred: StoredCredential, env?: NodeJS.ProcessEnv): string {
  const path = credentialPath(env);
  writePrivate(path, JSON.stringify(cred, null, 2) + "\n");
  return path;
}

export interface LoadedCredential {
  credential: StoredCredential;
  path: string;
  /** Set when file permissions are wider than 0600 — a warning, not a failure (AC-11.5). */
  permissionWarning: string | undefined;
}

/**
 * Whether the credential file's POSIX mode is wider than 0600 (AC-11.5).
 *
 * **Returns undefined on Windows, deliberately.** Node cannot express this check there:
 * `chmod` only toggles the read-only attribute, and `stat().mode` is *synthesized* — 0o666 when
 * writable, 0o444 when read-only — with NTFS ACLs invisible to it. So `saveCredential`'s
 * `chmod 0o600` is a no-op on Windows and the file can only ever report 666, which made this check
 * fire on **every single invocation** with a warning the user could not act on (#84).
 *
 * A warning nobody can satisfy is worse than no warning: it trains people to ignore the ones that
 * matter. And the 666 was never evidence of exposure — on Windows the file's actual protection is
 * the ACL inherited from the user's profile directory, which grants the owner, SYSTEM and
 * Administrators, not everyone. The CLI cannot read or set that ACL with Node, so it reports what
 * it knows and says so (see `auth status`) rather than asserting a guarantee it cannot make.
 *
 * `platform` is injectable so both branches are testable from either host.
 */
export function checkPermissions(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "win32") return undefined;
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return `${path} is mode ${mode.toString(8)}; expected 600`;
    }
  } catch {
    // Non-fatal: a stat failure must not prevent using a readable credential.
  }
  return undefined;
}

/**
 * True where the CLI cannot enforce or verify credential file permissions itself. Callers that
 * diagnose (`auth status`) should say where the protection actually comes from.
 */
export function permissionsAreUnenforceable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

export function loadCredential(env?: NodeJS.ProcessEnv): LoadedCredential | undefined {
  const path = credentialPath(env);
  if (!existsSync(path)) return undefined;

  const permissionWarning = checkPermissions(path);

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredCredential>;
    if (typeof parsed.token !== "string" || typeof parsed.url !== "string") return undefined;
    return {
      credential: {
        url: parsed.url,
        token: parsed.token,
        source: "browser-handoff",
        savedAt: parsed.savedAt ?? "unknown",
        ...(parsed.rotatedAt !== undefined ? { rotatedAt: parsed.rotatedAt } : {}),
      },
      path,
      permissionWarning,
    };
  } catch {
    return undefined;
  }
}

export function deleteCredential(env?: NodeJS.ProcessEnv): boolean {
  const path = credentialPath(env);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/**
 * Adopt a rotated token (AC-04.4). Returns an error message on failure rather than
 * throwing, so a rotation problem is reported without failing the user's command.
 */
export function rotateCredential(token: string, env?: NodeJS.ProcessEnv): string | undefined {
  const existing = loadCredential(env);
  if (existing === undefined) return "no stored credential to rotate";
  try {
    saveCredential({ ...existing.credential, token, rotatedAt: new Date().toISOString() }, env);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
